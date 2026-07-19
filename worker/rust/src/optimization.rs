use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet};

use anyhow::{Context, Result, bail};
use rayon::prelude::*;
use serde_json::{Map, Value, json};

use crate::backtest;
use crate::control::{ComputeControl, checkpoint};
use crate::model::{BacktestSimulationInput, TargetWeightScheduleEntry};
use crate::portfolio_math::{
    self, CovarianceEstimator, covariance_matrix, mean_returns, normalize_long_only,
    portfolio_variance,
};

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

    fn normal(&mut self) -> f64 {
        let left = self.next().max(f64::MIN_POSITIVE);
        let right = self.next();
        (-2.0 * left.ln()).sqrt() * (std::f64::consts::TAU * right).cos()
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegimePolicyMethod {
    Auto,
    DynamicProgramming,
    Mcts,
}

impl RegimePolicyMethod {
    fn parse(value: Option<&Value>) -> Result<Self> {
        match value
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "auto" => Ok(Self::Auto),
            "dynamic_programming" | "dp" => Ok(Self::DynamicProgramming),
            "mcts" | "uct_mcts" => Ok(Self::Mcts),
            value => bail!("unsupported regime policy search method: {value}"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::DynamicProgramming => "dynamic_programming",
            Self::Mcts => "mcts",
        }
    }
}

#[derive(Debug, Clone)]
struct RegimePolicyConfig {
    requested_method: RegimePolicyMethod,
    states: Vec<String>,
    actions: Vec<String>,
    lookback: usize,
    rebalance_every: usize,
    train_fraction: f64,
    minimum_training_decisions: usize,
    max_depth: usize,
    rollouts: usize,
    exploration_constant: f64,
    discount: f64,
    switching_cost_bps: f64,
    ledger_validation_budget: usize,
}

#[derive(Debug, Clone)]
struct RegimeDecision {
    date: String,
    signal_cutoff_date: String,
    return_start: usize,
    return_end: usize,
    state: usize,
    risk_score: f64,
    momentum: f64,
    annualized_volatility: f64,
    action_weights: Vec<Weights>,
}

#[derive(Debug, Clone)]
struct RegimePolicyCandidate {
    id: String,
    name: String,
    source: String,
    policy: Vec<Vec<usize>>,
    training_actions: Vec<usize>,
    oos_actions: Vec<usize>,
    training_metrics: Value,
    oos_metrics: Value,
    screening_rank: usize,
    validation_status: String,
    validation_error: Option<String>,
    ledger_metrics: Option<Value>,
    ledger_robust_detail: Option<Value>,
    ledger_data_quality: Option<Value>,
    ledger_rank: Option<usize>,
    rank_change: Option<i64>,
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

fn default_robust_weights() -> BTreeMap<String, f64> {
    BTreeMap::from([
        ("sharpe".to_owned(), 0.16),
        ("sortino".to_owned(), 0.14),
        ("calmar".to_owned(), 0.12),
        ("volatility".to_owned(), 0.12),
        ("cvar".to_owned(), 0.12),
        ("informationRatio".to_owned(), 0.08),
        ("oosAverageSharpe".to_owned(), 0.10),
        ("oosWorstSharpe".to_owned(), 0.10),
        ("oosAverageCvar".to_owned(), 0.06),
    ])
}

fn parse_robust_weights(value: Option<&Value>) -> BTreeMap<String, f64> {
    let mut weights = default_robust_weights();
    let Some(values) = value.and_then(Value::as_object) else {
        return weights;
    };
    let aliases = [
        ("inSampleSharpe", "sharpe"),
        ("inSampleSortino", "sortino"),
        ("inSampleCalmar", "calmar"),
        ("inSampleVolatility", "volatility"),
        ("inSampleCvar", "cvar"),
        ("inSampleInformationRatio", "informationRatio"),
        ("averageSharpe", "oosAverageSharpe"),
        ("worstSharpe", "oosWorstSharpe"),
        ("averageCvar", "oosAverageCvar"),
    ];
    for (key, value) in values {
        let canonical = aliases
            .iter()
            .find_map(|(alias, canonical)| (*alias == key).then_some(*canonical))
            .unwrap_or(key.as_str());
        if let Some(weight) = numeric(Some(value))
            && weight >= 0.0
            && weights.contains_key(canonical)
        {
            weights.insert(canonical.to_owned(), weight);
        }
    }
    let total = weights.values().sum::<f64>();
    if total > 0.0 {
        for weight in weights.values_mut() {
            *weight /= total;
        }
    } else {
        weights = default_robust_weights();
    }
    weights
}

fn parse_asset_groups(value: Option<&Value>) -> BTreeMap<String, BTreeMap<String, String>> {
    value
        .and_then(Value::as_object)
        .map(|assets| {
            assets
                .iter()
                .map(|(asset, metadata)| {
                    let metadata = metadata
                        .as_object()
                        .map(|fields| {
                            fields
                                .iter()
                                .filter_map(|(dimension, value)| {
                                    value
                                        .as_str()
                                        .filter(|value| !value.trim().is_empty())
                                        .map(|value| (dimension.clone(), value.to_owned()))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (asset.clone(), metadata)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_group_constraints(value: Option<&Value>) -> Result<Vec<GroupConstraint>> {
    let mut constraints = Vec::new();
    for item in value.and_then(Value::as_array).into_iter().flatten() {
        let object = item
            .as_object()
            .context("each group constraint must be an object")?;
        let dimension = object
            .get("dimension")
            .and_then(Value::as_str)
            .context("group constraint dimension is required")?;
        let group = object
            .get("group")
            .and_then(Value::as_str)
            .context("group constraint group is required")?;
        let min_weight = decimal(object.get("minWeight"), 0.0, 0.0, 1.0);
        let max_weight = decimal(object.get("maxWeight"), 1.0, 0.0, 1.0);
        if min_weight > max_weight {
            bail!("group constraint minWeight cannot exceed maxWeight");
        }
        constraints.push(GroupConstraint {
            dimension: dimension.to_owned(),
            group: group.to_owned(),
            min_weight,
            max_weight,
        });
    }
    Ok(constraints)
}

fn parse_v2_config(input: &Map<String, Value>) -> Result<OptimizerV2Config> {
    let algorithm = Algorithm::parse(input.get("algorithm"))?;
    let covariance_estimator = match input
        .get("covarianceEstimator")
        .and_then(Value::as_str)
        .unwrap_or("sample")
    {
        "sample" => CovarianceEstimator::Sample,
        "ledoit_wolf" => CovarianceEstimator::LedoitWolf,
        value => bail!("unsupported covariance estimator: {value}"),
    };
    let baseline_names = input
        .get("baselines")
        .map(|value| unique_strings(Some(value)))
        .unwrap_or_else(|| {
            BASELINE_NAMES
                .iter()
                .map(|value| (*value).to_owned())
                .collect()
        });
    if baseline_names
        .iter()
        .any(|value| !BASELINE_NAMES.contains(&value.as_str()))
    {
        bail!("unsupported baseline candidate");
    }
    Ok(OptimizerV2Config {
        algorithm,
        covariance_estimator,
        baseline_names,
        asset_groups: parse_asset_groups(input.get("assetGroups")),
        group_constraints: parse_group_constraints(input.get("groupConstraints"))?,
        robust_weights: parse_robust_weights(input.get("robustScoreWeights")),
        ledger_template: input
            .get("ledgerTemplate")
            .filter(|value| !value.is_null())
            .cloned(),
        ledger_validation_budget: positive_int(
            input.get("ledgerValidationBudget"),
            DEFAULT_LEDGER_VALIDATION_BUDGET as u64,
            1,
            128,
        ) as usize,
    })
}

fn default_regime_state_names(count: usize) -> Vec<String> {
    let names: &[&str] = match count {
        2 => &["risk_off", "risk_on"],
        3 => &["risk_off", "neutral", "risk_on"],
        4 => &["strong_risk_off", "risk_off", "risk_on", "strong_risk_on"],
        5 => &[
            "strong_risk_off",
            "risk_off",
            "neutral",
            "risk_on",
            "strong_risk_on",
        ],
        _ => &[],
    };
    if names.is_empty() {
        (0..count)
            .map(|index| format!("regime_{}", index + 1))
            .collect()
    } else {
        names.iter().map(|value| (*value).to_owned()).collect()
    }
}

fn parse_regime_states(value: Option<&Value>) -> Result<Vec<String>> {
    if let Some(values) = value.and_then(Value::as_array) {
        let mut seen = BTreeSet::new();
        let states = values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .context("regime policy states must contain non-empty strings")
            })
            .collect::<Result<Vec<_>>>()?;
        if !(2..=8).contains(&states.len())
            || !states.iter().all(|value| seen.insert(value.clone()))
        {
            bail!("regime policy states must contain 2..8 unique names");
        }
        return Ok(states);
    }
    let count = positive_int(value, 3, 2, 8) as usize;
    Ok(default_regime_state_names(count))
}

fn parse_regime_policy_config(
    input: &Map<String, Value>,
    default_actions: &[String],
    transaction_cost_bps: f64,
) -> Result<Option<RegimePolicyConfig>> {
    let Some(raw) = input.get("regimePolicySearch") else {
        return Ok(None);
    };
    if raw.is_null() || raw.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Ok(None);
    }
    let raw = raw
        .as_object()
        .context("regimePolicySearch must be an object")?;
    let actions = raw
        .get("baselineActions")
        .or_else(|| raw.get("actions"))
        .map(|value| unique_strings(Some(value)))
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| default_actions.to_vec());
    if actions.is_empty()
        || actions
            .iter()
            .any(|value| !BASELINE_NAMES.contains(&value.as_str()))
    {
        bail!("regime policy actions must be supported baseline names");
    }
    let states = parse_regime_states(raw.get("states"))?;
    let minimum_training_decisions = positive_int(
        raw.get("minimumTrainingDecisions"),
        (states.len() * 2).max(4) as u64,
        2,
        1_000,
    ) as usize;
    Ok(Some(RegimePolicyConfig {
        requested_method: RegimePolicyMethod::parse(raw.get("method"))?,
        states,
        actions,
        lookback: positive_int(raw.get("lookback"), 63, 5, 1_260) as usize,
        rebalance_every: positive_int(
            raw.get("rebalanceEvery")
                .or_else(|| raw.get("rebalanceInterval")),
            21,
            1,
            504,
        ) as usize,
        train_fraction: decimal(
            raw.get("trainFraction").or_else(|| raw.get("trainRatio")),
            0.7,
            0.5,
            0.9,
        ),
        minimum_training_decisions,
        max_depth: positive_int(raw.get("maxDepth"), 12, 1, 128) as usize,
        rollouts: positive_int(raw.get("rollouts"), 512, 16, 100_000) as usize,
        exploration_constant: decimal(
            raw.get("explorationConstant"),
            std::f64::consts::SQRT_2,
            0.0,
            10.0,
        ),
        discount: decimal(raw.get("discount"), 0.98, 0.5, 1.0),
        switching_cost_bps: numeric(raw.get("switchingCostBps"))
            .unwrap_or(transaction_cost_bps)
            .clamp(0.0, 500.0),
        ledger_validation_budget: positive_int(raw.get("ledgerValidationBudget"), 3, 1, 16)
            as usize,
    }))
}

fn walk_forward_config(config: Option<&Value>) -> (usize, usize, usize, usize, usize) {
    let config = config.and_then(Value::as_object);
    let get = |key| config.and_then(|value| value.get(key));
    let train = positive_int(get("trainWindow"), 126, 2, 10_000) as usize;
    let test = positive_int(get("testWindow"), 21, 1, 10_000) as usize;
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
    let config_object = config.and_then(Value::as_object);
    if config_object
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Vec::new();
    }
    if config_object
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        == Some("holdout")
    {
        let minimum_train = positive_int(
            config_object.and_then(|value| value.get("minimumTrainObservations")),
            20,
            2,
            10_000,
        ) as usize;
        let minimum_test = positive_int(
            config_object.and_then(|value| value.get("minimumTestObservations")),
            5,
            1,
            10_000,
        ) as usize;
        let gap = positive_int(
            config_object.and_then(|value| value.get("gap")),
            0,
            0,
            10_000,
        ) as usize;
        if safe_length < minimum_train + minimum_test + gap {
            return Vec::new();
        }
        let train_fraction = decimal(
            config_object.and_then(|value| value.get("trainFraction")),
            0.8,
            0.1,
            0.95,
        );
        let test_fraction = decimal(
            config_object.and_then(|value| value.get("testFraction")),
            0.2,
            0.05,
            0.5,
        );
        let available = safe_length - gap;
        let requested_test = ((safe_length as f64 * test_fraction).round() as usize)
            .clamp(minimum_test, available - minimum_train);
        let test_start = safe_length - requested_test;
        let test_end = safe_length - 1;
        let train_end = test_start - gap - 1;
        let maximum_train = train_end + 1;
        let requested_train = ((safe_length as f64 * train_fraction).round() as usize)
            .clamp(minimum_train, maximum_train);
        let train_start = maximum_train - requested_train;
        return vec![json!({
            "foldIndex": 0,
            "trainStartIndex": train_start,
            "trainEndIndex": train_end,
            "testStartIndex": test_start,
            "testEndIndex": test_end,
            "trainStart": format!("index-{train_start}"),
            "trainEnd": format!("index-{train_end}"),
            "testStart": format!("index-{test_start}"),
            "testEnd": format!("index-{test_end}"),
            "trainCount": requested_train,
            "testCount": requested_test,
            "gap": gap,
            "embargo": 0,
            "mode": "holdout",
        })];
    }
    let (train, test, step, minimum_train, minimum_test) = walk_forward_config(config);
    let gap = positive_int(
        config_object.and_then(|value| value.get("gap")),
        0,
        0,
        10_000,
    ) as usize;
    let embargo = positive_int(
        config_object.and_then(|value| value.get("embargo")),
        0,
        0,
        10_000,
    ) as usize;
    let requested_folds = positive_int(
        config_object.and_then(|value| value.get("foldCount")),
        5,
        2,
        100,
    ) as usize;
    let window_mode = config_object
        .and_then(|value| value.get("windowMode"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "rolling" | "anchored"))
        .unwrap_or("rolling");
    // Do not allow overlapping OOS windows. Embargo is measured from the end of
    // the previous test window to the beginning of the next one.
    let advance = step.max(test.saturating_add(embargo)).max(1);
    let mut windows = Vec::new();
    if safe_length == 0 {
        return windows;
    }

    let mut offset = 0usize;
    while windows.len() < requested_folds {
        let train_start = if window_mode == "anchored" { 0 } else { offset };
        let Some(train_end) = offset
            .checked_add(train)
            .and_then(|value| value.checked_sub(1))
        else {
            break;
        };
        let Some(test_start) = train_end
            .checked_add(1)
            .and_then(|value| value.checked_add(gap))
        else {
            break;
        };
        let Some(test_end) = test_start
            .checked_add(test)
            .and_then(|value| value.checked_sub(1))
        else {
            break;
        };
        if test_end >= safe_length {
            break;
        }
        let train_count = train_end - train_start + 1;
        let test_count = test_end - test_start + 1;
        if train_count >= minimum_train && test_count >= minimum_test {
            windows.push(json!({
                "foldIndex": windows.len(),
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
                "gap": gap,
                "embargo": embargo,
                "advance": advance,
                "mode": "walk_forward",
                "windowMode": window_mode,
            }));
        }
        let Some(next_offset) = offset.checked_add(advance) else {
            break;
        };
        offset = next_offset;
    }
    windows
}

fn training_frame(frame: &Frame, windows: &[Value]) -> Frame {
    let Some(first) = windows.first() else {
        return frame.clone();
    };
    let start = first
        .get("trainStartIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let end = first
        .get("trainEndIndex")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or_else(|| frame.dates.len().saturating_sub(1));
    if start > end || start >= frame.dates.len() {
        return frame.clone();
    }
    let end = end.min(frame.dates.len().saturating_sub(1));
    Frame {
        ids: frame.ids.clone(),
        dates: frame.dates[start..=end].to_vec(),
        returns: frame.returns[start..=end].to_vec(),
    }
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

fn group_matches(
    id: &str,
    constraint: &GroupConstraint,
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    asset_groups
        .get(id)
        .and_then(|metadata| metadata.get(&constraint.dimension))
        .is_some_and(|group| group == &constraint.group)
}

fn group_constraints_valid(
    weights: &Weights,
    group_constraints: &[GroupConstraint],
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    group_constraints.iter().all(|constraint| {
        let weight = weights
            .0
            .iter()
            .filter(|(id, _)| group_matches(id, constraint, asset_groups))
            .map(|(_, weight)| *weight)
            .sum::<f64>();
        weight + 1e-9 >= constraint.min_weight && weight <= constraint.max_weight + 1e-9
    })
}

fn repair_dense_weights(
    raw: &[f64],
    ids: &[String],
    constraints: &Constraints,
    group_constraints: &[GroupConstraint],
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> Option<Weights> {
    if ids.is_empty() || raw.len() != ids.len() {
        return None;
    }
    let mut selected = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| !constraints.excluded_assets.contains(id))
        .map(|(index, id)| (index, raw[index].max(0.0), id))
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| right.1.total_cmp(&left.1).then_with(|| left.2.cmp(right.2)));
    let mut mandatory = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| {
            constraints.required_assets.contains(id)
                || constraints
                    .min_weights
                    .get(*id)
                    .is_some_and(|value| *value > 0.0)
        })
        .map(|(index, _)| index)
        .collect::<BTreeSet<_>>();
    for group_constraint in group_constraints {
        for (inside, required_capacity) in [
            (true, group_constraint.min_weight),
            (false, 1.0 - group_constraint.max_weight),
        ] {
            if required_capacity <= 1e-12 {
                continue;
            }
            let maximum = |index: usize| {
                constraints
                    .max_weight
                    .min(*constraints.max_weights.get(&ids[index]).unwrap_or(&1.0))
            };
            let belongs =
                |index: usize| group_matches(&ids[index], group_constraint, asset_groups) == inside;
            let mut capacity = mandatory
                .iter()
                .copied()
                .filter(|index| belongs(*index))
                .map(maximum)
                .sum::<f64>();
            let mut members = (0..ids.len())
                .filter(|index| {
                    !constraints.excluded_assets.contains(&ids[*index]) && belongs(*index)
                })
                .collect::<Vec<_>>();
            members.sort_by(|left, right| {
                raw[*right]
                    .total_cmp(&raw[*left])
                    .then_with(|| ids[*left].cmp(&ids[*right]))
            });
            for index in members {
                if capacity + 1e-10 >= required_capacity {
                    break;
                }
                if mandatory.insert(index) {
                    capacity += maximum(index);
                }
            }
            if capacity + 1e-10 < required_capacity {
                return None;
            }
        }
    }
    if mandatory.len() > constraints.max_assets {
        return None;
    }
    let mut active = mandatory;
    for (index, _, _) in selected {
        if active.len() >= constraints.max_assets {
            break;
        }
        active.insert(index);
    }
    if active.is_empty() {
        return None;
    }
    let lower = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            if active.contains(&index) {
                constraints
                    .min_weight
                    .max(*constraints.min_weights.get(id).unwrap_or(&0.0))
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let upper = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            if active.contains(&index) {
                constraints
                    .max_weight
                    .min(*constraints.max_weights.get(id).unwrap_or(&1.0))
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    if lower.iter().zip(&upper).any(|(left, right)| left > right)
        || lower.iter().sum::<f64>() > 1.0 + 1e-10
        || upper.iter().sum::<f64>() < 1.0 - 1e-10
    {
        return None;
    }
    let mut values = lower.clone();
    let mut remaining = 1.0 - values.iter().sum::<f64>();
    for _ in 0..64 {
        if remaining <= 1e-12 {
            break;
        }
        let available = (0..ids.len())
            .filter(|index| upper[*index] - values[*index] > 1e-12)
            .collect::<Vec<_>>();
        if available.is_empty() {
            return None;
        }
        let raw_total = available
            .iter()
            .map(|index| raw[*index].max(1e-9))
            .sum::<f64>();
        let mut distributed = 0.0;
        for index in available {
            let addition =
                (remaining * raw[index].max(1e-9) / raw_total).min(upper[index] - values[index]);
            values[index] += addition;
            distributed += addition;
        }
        if distributed <= 1e-14 {
            return None;
        }
        remaining -= distributed;
    }
    if remaining > 1e-9 {
        return None;
    }

    for _ in 0..24 {
        let mut changed = false;
        for constraint in group_constraints {
            let inside = ids
                .iter()
                .enumerate()
                .filter(|(_, id)| group_matches(id, constraint, asset_groups))
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let outside = (0..ids.len())
                .filter(|index| !inside.contains(index))
                .collect::<Vec<_>>();
            let total = inside.iter().map(|index| values[*index]).sum::<f64>();
            if total + 1e-10 < constraint.min_weight {
                let needed = constraint.min_weight - total;
                let receive_capacity = inside
                    .iter()
                    .map(|index| upper[*index] - values[*index])
                    .sum::<f64>();
                let donor_capacity = outside
                    .iter()
                    .map(|index| values[*index] - lower[*index])
                    .sum::<f64>();
                if receive_capacity + 1e-10 < needed || donor_capacity + 1e-10 < needed {
                    return None;
                }
                for index in &outside {
                    let capacity = values[*index] - lower[*index];
                    values[*index] -= needed * capacity / donor_capacity.max(1e-18);
                }
                for index in &inside {
                    let capacity = upper[*index] - values[*index];
                    values[*index] += needed * capacity / receive_capacity.max(1e-18);
                }
                changed = true;
            } else if total > constraint.max_weight + 1e-10 {
                let excess = total - constraint.max_weight;
                let donor_capacity = inside
                    .iter()
                    .map(|index| values[*index] - lower[*index])
                    .sum::<f64>();
                let receive_capacity = outside
                    .iter()
                    .map(|index| upper[*index] - values[*index])
                    .sum::<f64>();
                if donor_capacity + 1e-10 < excess || receive_capacity + 1e-10 < excess {
                    return None;
                }
                for index in &inside {
                    let capacity = values[*index] - lower[*index];
                    values[*index] -= excess * capacity / donor_capacity.max(1e-18);
                }
                for index in &outside {
                    let capacity = upper[*index] - values[*index];
                    values[*index] += excess * capacity / receive_capacity.max(1e-18);
                }
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let weights = Weights::from_dense(ids, &values);
    group_constraints_valid(&weights, group_constraints, asset_groups).then_some(weights)
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

fn herc_correlation_distance(covariance: &[Vec<f64>], left: usize, right: usize) -> f64 {
    let left_variance = covariance[left][left].max(0.0);
    let right_variance = covariance[right][right].max(0.0);
    let denominator = (left_variance * right_variance).sqrt();
    let correlation = if denominator > 1e-18 {
        (covariance[left][right] / denominator).clamp(-1.0, 1.0)
    } else if left == right {
        1.0
    } else {
        0.0
    };
    ((1.0 - correlation) * 0.5).max(0.0).sqrt()
}

fn herc_average_linkage(left: &[usize], right: &[usize], distances: &[Vec<f64>]) -> f64 {
    let pair_count = left.len().saturating_mul(right.len()).max(1);
    left.iter()
        .flat_map(|left_asset| {
            right
                .iter()
                .map(move |right_asset| distances[*left_asset][*right_asset])
        })
        .sum::<f64>()
        / pair_count as f64
}

fn herc_mean_silhouette(clusters: &[Vec<usize>], distances: &[Vec<f64>]) -> f64 {
    let asset_count = clusters.iter().map(Vec::len).sum::<usize>();
    if clusters.len() < 2 || asset_count == 0 {
        return 0.0;
    }
    let mut total = 0.0;
    for (cluster_index, cluster) in clusters.iter().enumerate() {
        for asset in cluster {
            if cluster.len() == 1 {
                continue;
            }
            let within = cluster
                .iter()
                .filter(|other| *other != asset)
                .map(|other| distances[*asset][*other])
                .sum::<f64>()
                / (cluster.len() - 1) as f64;
            let nearest = clusters
                .iter()
                .enumerate()
                .filter(|(other_index, _)| *other_index != cluster_index)
                .map(|(_, other)| {
                    other
                        .iter()
                        .map(|other_asset| distances[*asset][*other_asset])
                        .sum::<f64>()
                        / other.len().max(1) as f64
                })
                .fold(f64::INFINITY, f64::min);
            let scale = within.max(nearest);
            if scale > 1e-18 && nearest.is_finite() {
                total += (nearest - within) / scale;
            }
        }
    }
    total / asset_count as f64
}

/// Builds a deterministic flat cut of an average-linkage correlation-distance hierarchy.
///
/// HERC needs an explicit cluster cut before it can balance risk inside and between clusters.
/// We select the cut with the highest mean silhouette over every non-trivial dendrogram level;
/// exact-score ties prefer fewer clusters. This avoids a random reference distribution while
/// retaining the hierarchical structure and stable results for a fixed covariance matrix.
fn herc_partition(covariance: &[Vec<f64>]) -> Option<Vec<Vec<usize>>> {
    let asset_count = covariance.len();
    if asset_count == 0
        || covariance
            .iter()
            .any(|row| row.len() != asset_count || row.iter().any(|value| !value.is_finite()))
    {
        return None;
    }
    if asset_count <= 2 {
        return Some((0..asset_count).map(|index| vec![index]).collect());
    }
    let distances = (0..asset_count)
        .map(|left| {
            (0..asset_count)
                .map(|right| herc_correlation_distance(covariance, left, right))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut clusters = (0..asset_count)
        .map(|index| vec![index])
        .collect::<Vec<_>>();
    let mut best_partition = None::<Vec<Vec<usize>>>;
    let mut best_score = f64::NEG_INFINITY;
    while clusters.len() > 2 {
        let mut best_pair = None::<(usize, usize, f64)>;
        for left in 0..clusters.len() {
            for right in left + 1..clusters.len() {
                let distance = herc_average_linkage(&clusters[left], &clusters[right], &distances);
                let replace = best_pair.is_none_or(|(best_left, best_right, best_distance)| {
                    distance.total_cmp(&best_distance) == Ordering::Less
                        || (distance.total_cmp(&best_distance) == Ordering::Equal
                            && (left, right) < (best_left, best_right))
                });
                if replace {
                    best_pair = Some((left, right, distance));
                }
            }
        }
        let (left, right, _) = best_pair?;
        let right_cluster = clusters.remove(right);
        clusters[left].extend(right_cluster);
        clusters[left].sort_unstable();
        clusters.sort();

        let score = herc_mean_silhouette(&clusters, &distances);
        let fewer_clusters = best_partition
            .as_ref()
            .is_some_and(|best| clusters.len() < best.len());
        if score > best_score + 1e-12 || ((score - best_score).abs() <= 1e-12 && fewer_clusters) {
            best_score = score;
            best_partition = Some(clusters.clone());
        }
    }
    best_partition.or(Some(clusters))
}

fn covariance_submatrix(covariance: &[Vec<f64>], indices: &[usize]) -> Vec<Vec<f64>> {
    indices
        .iter()
        .map(|left| {
            indices
                .iter()
                .map(|right| covariance[*left][*right])
                .collect()
        })
        .collect()
}

fn herc_cluster_covariance(
    covariance: &[Vec<f64>],
    clusters: &[Vec<usize>],
    within_weights: &[Vec<f64>],
) -> Vec<Vec<f64>> {
    let mut result = vec![vec![0.0; clusters.len()]; clusters.len()];
    for (left_cluster, left_assets) in clusters.iter().enumerate() {
        for (right_cluster, right_assets) in clusters.iter().enumerate() {
            for (left_position, left_asset) in left_assets.iter().enumerate() {
                for (right_position, right_asset) in right_assets.iter().enumerate() {
                    result[left_cluster][right_cluster] += within_weights[left_cluster]
                        [left_position]
                        * within_weights[right_cluster][right_position]
                        * covariance[*left_asset][*right_asset];
                }
            }
        }
    }
    result
}

/// Deterministic HERC-style allocation used by the optimizer baseline.
///
/// 1. Cluster assets with average-linkage correlation distance and a silhouette-selected cut.
/// 2. Solve equal-risk-contribution weights inside every cluster.
/// 3. Aggregate those fixed sub-portfolios into a cluster covariance matrix and solve ERC again
///    at the cluster level.
/// 4. Multiply cluster and member weights, then normalize long-only.
///
/// The optimizer's existing repair step subsequently applies asset/group/cardinality constraints.
fn hierarchical_equal_risk_contribution(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    let clusters = herc_partition(covariance)?;
    if clusters.is_empty() {
        return None;
    }
    let within_weights = clusters
        .iter()
        .map(|cluster| {
            if cluster.len() == 1 {
                Some(vec![1.0])
            } else {
                let submatrix = covariance_submatrix(covariance, cluster);
                portfolio_math::risk_parity(&submatrix)
                    .or_else(|| portfolio_math::inverse_volatility(&submatrix))
            }
        })
        .collect::<Option<Vec<_>>>()?;
    let cluster_covariance = herc_cluster_covariance(covariance, &clusters, &within_weights);
    let cluster_weights = portfolio_math::risk_parity(&cluster_covariance)
        .or_else(|| portfolio_math::inverse_volatility(&cluster_covariance))?;
    let mut weights = vec![0.0; covariance.len()];
    for (cluster_index, cluster) in clusters.iter().enumerate() {
        for (member_index, asset) in cluster.iter().enumerate() {
            weights[*asset] =
                cluster_weights[cluster_index] * within_weights[cluster_index][member_index];
        }
    }
    normalize_long_only(&weights)
}

fn baseline_dense_weights(
    name: &str,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
) -> Option<Vec<f64>> {
    match name {
        "equal_weight" => portfolio_math::equal_weight(frame.ids.len()),
        "current_weight" => normalize_long_only(
            &frame
                .ids
                .iter()
                .map(|id| constraints.current_weights.get(id).copied().unwrap_or(0.0))
                .collect::<Vec<_>>(),
        )
        .or_else(|| portfolio_math::equal_weight(frame.ids.len())),
        "inverse_volatility" => portfolio_math::inverse_volatility(covariance),
        "minimum_variance" => portfolio_math::minimum_variance(covariance),
        "risk_parity" => portfolio_math::risk_parity(covariance),
        "hrp" => portfolio_math::hrp(covariance),
        "herc" => hierarchical_equal_risk_contribution(covariance),
        _ => None,
    }
}

fn baseline_candidates(
    frame: &Frame,
    covariance: &[Vec<f64>],
    config: &OptimizerV2Config,
    constraints: &Constraints,
) -> Vec<(Weights, String)> {
    config
        .baseline_names
        .iter()
        .filter_map(|name| {
            repair_dense_weights(
                &baseline_dense_weights(name, frame, covariance, constraints)?,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            )
            .map(|weights| (weights, format!("baseline:{name}")))
        })
        .collect()
}

fn random_dense_candidate(
    rng: &mut Mulberry32,
    frame: &Frame,
    constraints: &Constraints,
    config: &OptimizerV2Config,
) -> Option<Weights> {
    let raw = frame
        .ids
        .iter()
        .map(|_| -rng.next().max(f64::MIN_POSITIVE).ln())
        .collect::<Vec<_>>();
    repair_dense_weights(
        &raw,
        &frame.ids,
        constraints,
        &config.group_constraints,
        &config.asset_groups,
    )
}

fn training_objective_fitness(
    frame: &Frame,
    weights: &Weights,
    objective: &str,
    options: &EvaluationOptions<'_>,
) -> f64 {
    // Search fitness must never consume the inner OOS windows. Reuse the canonical
    // candidate evaluator with an explicitly training-only view so metric semantics
    // (risk-free rate, benchmark, transaction cost, and robust weights) stay aligned
    // with the screening result without leaking validation observations.
    let training_options = EvaluationOptions {
        benchmark: options.benchmark,
        oos_frame: None,
        annualization: options.annualization,
        confidence: options.confidence,
        minimum_samples: options.minimum_samples,
        risk_free_percent: options.risk_free_percent,
        windows: &[],
        validation_config: None,
        constraints: options.constraints,
        transaction_cost_bps: options.transaction_cost_bps,
        robust_weights: options.robust_weights,
    };
    let candidate = evaluate_candidate(frame, weights, &training_options);
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
        _ => return f64::NEG_INFINITY,
    };
    as_metric(&candidate, key)
        .map(|value| match objective {
            "min_volatility" => -value,
            "min_cvar" => -value.abs(),
            _ => value,
        })
        .filter(|value| value.is_finite())
        .unwrap_or(f64::NEG_INFINITY)
}

fn differential_evolution_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    constraints: &Constraints,
    config: &OptimizerV2Config,
    fitness: (&str, &EvaluationOptions<'_>),
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() {
        return Vec::new();
    }
    let population_size = (frame.ids.len() * 6)
        .clamp(12, 64)
        .min((budget / 2).max(4))
        .min(budget);
    let mut population = Vec::new();
    for _ in 0..population_size * 20 {
        if let Some(candidate) = random_dense_candidate(rng, frame, constraints, config) {
            population.push(candidate);
            if population.len() == population_size {
                break;
            }
        }
    }
    let mut population_fitness = population
        .iter()
        .map(|weights| training_objective_fitness(frame, weights, fitness.0, fitness.1))
        .collect::<Vec<_>>();
    let mut output = population
        .iter()
        .cloned()
        .map(|weights| (weights, "differential_evolution".to_owned()))
        .collect::<Vec<_>>();
    let mut generations = 0usize;
    while output.len() < budget && population.len() >= 4 && generations < budget * 4 {
        generations += 1;
        for target in 0..population.len() {
            let mut picks = Vec::new();
            while picks.len() < 3 {
                let pick = rng.next_int(population.len());
                if pick != target && !picks.contains(&pick) {
                    picks.push(pick);
                }
            }
            let a = population[picks[0]].dense(&frame.ids);
            let b = population[picks[1]].dense(&frame.ids);
            let c = population[picks[2]].dense(&frame.ids);
            let current = population[target].dense(&frame.ids);
            let forced = rng.next_int(frame.ids.len());
            let raw = (0..frame.ids.len())
                .map(|index| {
                    if index == forced || rng.next() < 0.75 {
                        a[index] + 0.65 * (b[index] - c[index])
                    } else {
                        current[index]
                    }
                })
                .collect::<Vec<_>>();
            let Some(trial) = repair_dense_weights(
                &raw,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            ) else {
                continue;
            };
            let trial_fitness = training_objective_fitness(frame, &trial, fitness.0, fitness.1);
            if trial_fitness >= population_fitness[target] {
                population[target] = trial.clone();
                population_fitness[target] = trial_fitness;
            }
            output.push((trial, "differential_evolution".to_owned()));
            if output.len() >= budget {
                break;
            }
        }
    }
    // Put the evolved population first. The caller may over-generate and then
    // truncate after de-duplication, so returning the initial population first
    // would silently discard every objective-aware selection step.
    let mut prioritized = Vec::with_capacity(budget);
    let mut seen = HashSet::new();
    for weights in population
        .into_iter()
        .chain(output.into_iter().map(|(weights, _)| weights))
    {
        if seen.insert(signature(&weights)) {
            prioritized.push((weights, "differential_evolution".to_owned()));
            if prioritized.len() >= budget {
                break;
            }
        }
    }
    prioritized
}

fn cma_es_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
    config: &OptimizerV2Config,
    fitness: (&str, &EvaluationOptions<'_>),
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() {
        return Vec::new();
    }
    let dimensions = frame.ids.len();
    let mut center = portfolio_math::inverse_volatility(covariance)
        .or_else(|| portfolio_math::equal_weight(dimensions))
        .unwrap_or_default();
    let mut diagonal = vec![1.0_f64; dimensions];
    let mut covariance_path = vec![0.0_f64; dimensions];
    let mut step_path = vec![0.0_f64; dimensions];
    let lambda = (4.0 + 3.0 * (dimensions as f64).ln()).round() as usize;
    let lambda = lambda.max(4).min(budget.max(4));
    let mut sigma = 0.25_f64;
    let expected_normal_length = (dimensions as f64).sqrt()
        * (1.0 - 1.0 / (4.0 * dimensions as f64) + 1.0 / (21.0 * (dimensions * dimensions) as f64));
    let mut output = Vec::new();
    let mut final_generation = Vec::new();
    let mut generation_index = 0usize;
    while output.len() < budget {
        generation_index += 1;
        let mut generation = Vec::new();
        for _ in 0..lambda {
            let raw = (0..dimensions)
                .map(|index| center[index] + sigma * diagonal[index].sqrt() * rng.normal())
                .collect::<Vec<_>>();
            if let Some(weights) = repair_dense_weights(
                &raw,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            ) {
                let score = training_objective_fitness(frame, &weights, fitness.0, fitness.1);
                generation.push((score, weights));
            }
        }
        if generation.is_empty() {
            break;
        }
        generation.sort_by(|left, right| right.0.total_cmp(&left.0));
        let elite_count = (generation.len() / 2).max(1);
        let elites = &generation[..elite_count];
        let mut recombination_weights = (0..elite_count)
            .map(|index| ((elite_count as f64 + 0.5).ln() - ((index + 1) as f64).ln()).max(0.0))
            .collect::<Vec<_>>();
        let weight_total = recombination_weights.iter().sum::<f64>().max(1e-18);
        for weight in &mut recombination_weights {
            *weight /= weight_total;
        }
        let effective_mu = 1.0
            / recombination_weights
                .iter()
                .map(|weight| weight * weight)
                .sum::<f64>()
                .max(1e-18);
        let dimension = dimensions as f64;
        let step_path_rate = (effective_mu + 2.0) / (dimension + effective_mu + 5.0);
        let step_damping =
            1.0 + 2.0 * ((effective_mu - 1.0).max(0.0) / (dimension + 1.0)).sqrt() + step_path_rate;
        let covariance_path_rate =
            (4.0 + effective_mu / dimension) / (dimension + 4.0 + 2.0 * effective_mu / dimension);
        let rank_one_rate = 2.0 / ((dimension + 1.3).powi(2) + effective_mu);
        let rank_mu_rate = (2.0 * (effective_mu - 2.0 + 1.0 / effective_mu)
            / ((dimension + 2.0).powi(2) + effective_mu))
            .clamp(0.0, 1.0 - rank_one_rate);
        let old_center = center.clone();
        let old_diagonal = diagonal.clone();
        let elite_dense = elites
            .iter()
            .map(|(_, weights)| weights.dense(&frame.ids))
            .collect::<Vec<_>>();
        let weighted_step = (0..dimensions)
            .map(|index| {
                elite_dense
                    .iter()
                    .zip(&recombination_weights)
                    .map(|(weights, weight)| {
                        weight * (weights[index] - old_center[index]) / sigma.max(1e-18)
                    })
                    .sum::<f64>()
            })
            .collect::<Vec<_>>();
        center = (0..dimensions)
            .map(|index| {
                elite_dense
                    .iter()
                    .zip(&recombination_weights)
                    .map(|(weights, weight)| weight * weights[index])
                    .sum::<f64>()
            })
            .collect();
        for index in 0..dimensions {
            let whitened_step = weighted_step[index] / old_diagonal[index].sqrt().max(1e-18);
            step_path[index] = (1.0 - step_path_rate) * step_path[index]
                + (step_path_rate * (2.0 - step_path_rate) * effective_mu).sqrt() * whitened_step;
        }
        let step_path_length = step_path
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt();
        let normalized_path_length = step_path_length
            / (1.0 - (1.0 - step_path_rate).powi(2 * generation_index as i32))
                .sqrt()
                .max(1e-18);
        let path_is_stable =
            normalized_path_length < (1.4 + 2.0 / (dimension + 1.0)) * expected_normal_length;
        let path_indicator = if path_is_stable { 1.0 } else { 0.0 };
        for index in 0..dimensions {
            covariance_path[index] = (1.0 - covariance_path_rate) * covariance_path[index]
                + path_indicator
                    * (covariance_path_rate * (2.0 - covariance_path_rate) * effective_mu).sqrt()
                    * weighted_step[index];
            let rank_mu = elite_dense
                .iter()
                .zip(&recombination_weights)
                .map(|(weights, weight)| {
                    let step = (weights[index] - old_center[index]) / sigma.max(1e-18);
                    weight * step * step
                })
                .sum::<f64>();
            diagonal[index] = ((1.0 - rank_one_rate - rank_mu_rate) * old_diagonal[index]
                + rank_one_rate
                    * (covariance_path[index].powi(2)
                        + (1.0 - path_indicator)
                            * covariance_path_rate
                            * (2.0 - covariance_path_rate)
                            * old_diagonal[index])
                + rank_mu_rate * rank_mu)
                .clamp(1e-12, 1e6);
        }
        sigma *= ((step_path_rate / step_damping)
            * (step_path_length / expected_normal_length.max(1e-18) - 1.0))
            .exp();
        sigma = sigma.clamp(1e-4, 2.0);
        final_generation = generation
            .iter()
            .map(|(_, weights)| weights.clone())
            .collect();
        output.extend(
            generation
                .into_iter()
                .map(|(_, weights)| (weights, "cma_es".to_owned())),
        );
    }
    // As with DE, prioritize the latest ranked generation so an upstream
    // over-generation/truncation step retains the objective-guided search result.
    let mut prioritized = Vec::with_capacity(budget);
    let mut seen = HashSet::new();
    for weights in final_generation
        .into_iter()
        .chain(output.into_iter().map(|(weights, _)| weights))
    {
        if seen.insert(signature(&weights)) {
            prioritized.push((weights, "cma_es".to_owned()));
            if prioritized.len() >= budget {
                break;
            }
        }
    }
    prioritized
}

fn proxy_dominates(left: ProxyMetrics, right: ProxyMetrics) -> bool {
    let no_worse = left.portfolio_return >= right.portfolio_return
        && left.volatility <= right.volatility
        && left.cvar >= right.cvar;
    no_worse
        && (left.portfolio_return > right.portfolio_return
            || left.volatility < right.volatility
            || left.cvar > right.cvar)
}

fn nsga_rank_and_crowding(metrics: &[ProxyMetrics]) -> Vec<(usize, f64)> {
    let mut remaining = (0..metrics.len()).collect::<Vec<_>>();
    let mut result = vec![(usize::MAX, 0.0); metrics.len()];
    let mut rank = 0usize;
    while !remaining.is_empty() {
        let front = remaining
            .iter()
            .copied()
            .filter(|candidate| {
                !remaining.iter().copied().any(|other| {
                    other != *candidate && proxy_dominates(metrics[other], metrics[*candidate])
                })
            })
            .collect::<Vec<_>>();
        if front.is_empty() {
            break;
        }
        for candidate in &front {
            result[*candidate].0 = rank;
        }
        for dimension in 0..3 {
            let mut sorted = front.clone();
            sorted.sort_by(|left, right| {
                let value = |index: usize| match dimension {
                    0 => metrics[index].portfolio_return,
                    1 => metrics[index].volatility,
                    _ => metrics[index].cvar,
                };
                value(*left).total_cmp(&value(*right))
            });
            if let (Some(first), Some(last)) = (sorted.first(), sorted.last()) {
                result[*first].1 = f64::INFINITY;
                result[*last].1 = f64::INFINITY;
                let low = match dimension {
                    0 => metrics[*first].portfolio_return,
                    1 => metrics[*first].volatility,
                    _ => metrics[*first].cvar,
                };
                let high = match dimension {
                    0 => metrics[*last].portfolio_return,
                    1 => metrics[*last].volatility,
                    _ => metrics[*last].cvar,
                };
                let span = (high - low).abs().max(1e-18);
                for window in sorted.windows(3) {
                    let previous = match dimension {
                        0 => metrics[window[0]].portfolio_return,
                        1 => metrics[window[0]].volatility,
                        _ => metrics[window[0]].cvar,
                    };
                    let next = match dimension {
                        0 => metrics[window[2]].portfolio_return,
                        1 => metrics[window[2]].volatility,
                        _ => metrics[window[2]].cvar,
                    };
                    result[window[1]].1 += (next - previous).abs() / span;
                }
            }
        }
        let front_set = front.into_iter().collect::<BTreeSet<_>>();
        remaining.retain(|candidate| !front_set.contains(candidate));
        rank += 1;
    }
    result
}

fn nsga_ii_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
    config: &OptimizerV2Config,
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() {
        return Vec::new();
    }
    let population_size = (frame.ids.len() * 8)
        .clamp(16, 80)
        .min((budget / 2).max(4))
        .min(budget);
    let mut population = Vec::new();
    for _ in 0..population_size * 20 {
        if let Some(candidate) = random_dense_candidate(rng, frame, constraints, config) {
            population.push(candidate);
            if population.len() == population_size {
                break;
            }
        }
    }
    let mut output = population
        .iter()
        .cloned()
        .map(|weights| (weights, "nsga_ii".to_owned()))
        .collect::<Vec<_>>();
    while output.len() < budget && population.len() >= 2 {
        let metrics = population
            .iter()
            .map(|weights| proxy_metrics(frame, covariance, &weights.dense(&frame.ids)))
            .collect::<Vec<_>>();
        let rank = nsga_rank_and_crowding(&metrics);
        let tournament = |left: usize, right: usize| {
            if rank[left].0 < rank[right].0
                || (rank[left].0 == rank[right].0 && rank[left].1 >= rank[right].1)
            {
                left
            } else {
                right
            }
        };
        let mut offspring = Vec::new();
        for _ in 0..population_size {
            let left = tournament(
                rng.next_int(population.len()),
                rng.next_int(population.len()),
            );
            let right = tournament(
                rng.next_int(population.len()),
                rng.next_int(population.len()),
            );
            let left = population[left].dense(&frame.ids);
            let right = population[right].dense(&frame.ids);
            let mix = rng.next();
            let raw = left
                .iter()
                .zip(right)
                .map(|(left, right)| mix * left + (1.0 - mix) * right + 0.04 * rng.normal())
                .collect::<Vec<_>>();
            if let Some(candidate) = repair_dense_weights(
                &raw,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            ) {
                offspring.push(candidate);
            }
        }
        if offspring.is_empty() {
            break;
        }
        let mut combined = population;
        combined.extend(offspring.iter().cloned());
        let combined_metrics = combined
            .iter()
            .map(|weights| proxy_metrics(frame, covariance, &weights.dense(&frame.ids)))
            .collect::<Vec<_>>();
        let combined_rank = nsga_rank_and_crowding(&combined_metrics);
        let mut indices = (0..combined.len()).collect::<Vec<_>>();
        indices.sort_by(|left, right| {
            combined_rank[*left]
                .0
                .cmp(&combined_rank[*right].0)
                .then_with(|| combined_rank[*right].1.total_cmp(&combined_rank[*left].1))
                .then_with(|| left.cmp(right))
        });
        population = indices
            .into_iter()
            .take(population_size)
            .map(|index| combined[index].clone())
            .collect();
        output.extend(
            offspring
                .into_iter()
                .map(|weights| (weights, "nsga_ii".to_owned())),
        );
    }
    output.truncate(budget);
    output
}

fn direct_cvar_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    constraints: &Constraints,
    config: &OptimizerV2Config,
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() || frame.returns.is_empty() {
        return Vec::new();
    }
    let mut weights = portfolio_math::equal_weight(frame.ids.len()).unwrap_or_default();
    let mut output = Vec::new();
    for iteration in 0..budget * 8 {
        let returns = portfolio_returns(frame, &weights);
        let threshold = quantile_linear(&returns, 0.05).unwrap_or(0.0);
        let tail = returns
            .iter()
            .enumerate()
            .filter(|(_, value)| **value <= threshold)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let step = 0.15 / (1.0 + iteration as f64 * 0.05).sqrt();
        let gradient = (0..frame.ids.len())
            .map(|asset| {
                if tail.is_empty() {
                    0.0
                } else {
                    tail.iter()
                        .map(|index| frame.returns[*index][asset])
                        .sum::<f64>()
                        / tail.len() as f64
                }
            })
            .collect::<Vec<_>>();
        let raw = weights
            .iter()
            .zip(gradient)
            .map(|(weight, gradient)| weight + step * gradient + rng.normal() * step * 0.02)
            .collect::<Vec<_>>();
        if let Some(candidate) = repair_dense_weights(
            &raw,
            &frame.ids,
            constraints,
            &config.group_constraints,
            &config.asset_groups,
        ) {
            weights = candidate.dense(&frame.ids);
            output.push((candidate, "direct_cvar".to_owned()));
            if output.len() >= budget {
                break;
            }
        }
    }
    output
}

fn advanced_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
    config: &OptimizerV2Config,
    fitness: (&str, &EvaluationOptions<'_>),
    budget: usize,
) -> Vec<(Weights, String)> {
    match config.algorithm {
        Algorithm::RandomSearch => Vec::new(),
        Algorithm::DifferentialEvolution => {
            differential_evolution_candidates(rng, frame, constraints, config, fitness, budget)
        }
        Algorithm::CmaEs => {
            cma_es_candidates(rng, frame, covariance, constraints, config, fitness, budget)
        }
        Algorithm::NsgaIi => {
            nsga_ii_candidates(rng, frame, covariance, constraints, config, budget)
        }
        Algorithm::DirectCvar => direct_cvar_candidates(rng, frame, constraints, config, budget),
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

    json!({
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
    })
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

#[derive(Debug, Clone, Copy)]
struct ParetoPoint {
    /// Every value is transformed so a larger value is preferable.
    values: [Option<f64>; 6],
}

impl ParetoPoint {
    fn from_candidate(candidate: &Value) -> Self {
        Self {
            values: [
                as_metric(candidate, "return"),
                as_metric(candidate, "volatility").map(|value| -value),
                as_metric(candidate, "maxDrawdown").map(|value| -value.abs()),
                as_metric(candidate, "cvar").map(|value| -value.abs()),
                as_metric(candidate, "turnover").map(|value| -value),
                as_metric(candidate, "transactionCost").map(|value| -value),
            ],
        }
    }

    fn is_complete(self) -> bool {
        self.values.iter().all(Option::is_some)
    }
}

fn typed_dominates(left: ParetoPoint, right: ParetoPoint) -> bool {
    let mut comparable = 0usize;
    let mut strictly_better = false;
    for (left, right) in left.values.into_iter().zip(right.values) {
        let (Some(left), Some(right)) = (left, right) else {
            continue;
        };
        comparable += 1;
        if left < right {
            return false;
        }
        strictly_better |= left > right;
    }
    comparable > 0 && strictly_better
}

fn pareto_indices(
    points: &[ParetoPoint],
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<usize>> {
    if points.iter().all(|point| point.is_complete()) {
        let mut frontier = Vec::<usize>::new();
        for (index, candidate) in points.iter().copied().enumerate() {
            if index.is_multiple_of(256) {
                checkpoint(control)?;
            }
            if frontier
                .iter()
                .any(|other| typed_dominates(points[*other], candidate))
            {
                continue;
            }
            frontier.retain(|other| !typed_dominates(candidate, points[*other]));
            frontier.push(index);
        }
        return Ok(frontier);
    }

    // Missing metrics make the legacy pairwise relation non-transitive. Retain exact historical
    // semantics for those uncommon candidates while still avoiding repeated JSON traversal.
    let mut frontier = Vec::new();
    for (index, candidate) in points.iter().copied().enumerate() {
        if index.is_multiple_of(128) {
            checkpoint(control)?;
        }
        let dominated = points
            .iter()
            .copied()
            .enumerate()
            .any(|(other, point)| other != index && typed_dominates(point, candidate));
        if !dominated {
            frontier.push(index);
        }
    }
    Ok(frontier)
}

pub fn pareto(candidates: &[Value]) -> Vec<Value> {
    let points = candidates
        .iter()
        .map(ParetoPoint::from_candidate)
        .collect::<Vec<_>>();
    pareto_indices(&points, None)
        .expect("pareto without a control cannot be cancelled")
        .into_iter()
        .map(|index| candidates[index].clone())
        .collect()
}

fn pareto_with_control(
    candidates: &[Value],
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Value>> {
    let points = candidates
        .iter()
        .map(ParetoPoint::from_candidate)
        .collect::<Vec<_>>();
    Ok(pareto_indices(&points, control)?
        .into_iter()
        .map(|index| candidates[index].clone())
        .collect())
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

fn template_asset_index(template: &BacktestSimulationInput, id: &str) -> Result<usize> {
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

fn ledger_input_for_candidate(
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

fn ledger_metrics(
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

fn regime_state_index(risk_score: f64, state_count: usize) -> usize {
    if state_count <= 1 {
        return 0;
    }
    let scaled = ((risk_score.clamp(-1.0, 1.0) + 1.0) * 0.5 * state_count as f64).floor();
    (scaled as usize).min(state_count - 1)
}

fn build_regime_decisions(
    frame: &Frame,
    config: &RegimePolicyConfig,
    optimizer_config: &OptimizerV2Config,
    constraints: &Constraints,
    control: Option<&dyn ComputeControl>,
) -> Result<(Vec<RegimeDecision>, Vec<String>, Vec<String>)> {
    if frame.returns.len() <= config.lookback || frame.ids.is_empty() {
        bail!(
            "regime policy search requires more than {} aligned return observations",
            config.lookback
        );
    }
    let mut provisional = Vec::<(
        String,
        String,
        usize,
        usize,
        usize,
        f64,
        f64,
        f64,
        Vec<Option<Weights>>,
    )>::new();
    let mut valid_actions = vec![true; config.actions.len()];
    for (decision_number, return_start) in (config.lookback..frame.returns.len())
        .step_by(config.rebalance_every)
        .enumerate()
    {
        if decision_number.is_multiple_of(8) {
            checkpoint(control)?;
        }
        let history_start = return_start - config.lookback;
        let history = Frame {
            ids: frame.ids.clone(),
            dates: frame.dates[history_start..return_start].to_vec(),
            returns: frame.returns[history_start..return_start].to_vec(),
        };
        let covariance = covariance_matrix(
            &history.returns,
            history.ids.len(),
            optimizer_config.covariance_estimator,
        );
        let action_weights = config
            .actions
            .iter()
            .enumerate()
            .map(|(action_index, action)| {
                let weights = baseline_dense_weights(action, &history, &covariance, constraints)
                    .and_then(|dense| {
                        repair_dense_weights(
                            &dense,
                            &frame.ids,
                            constraints,
                            &optimizer_config.group_constraints,
                            &optimizer_config.asset_groups,
                        )
                    });
                if weights.is_none() {
                    valid_actions[action_index] = false;
                }
                weights
            })
            .collect::<Vec<_>>();
        let market_returns = history
            .returns
            .iter()
            .map(|row| mean(row))
            .collect::<Vec<_>>();
        let momentum = market_returns
            .iter()
            .fold(1.0, |growth, value| growth * (1.0 + value))
            - 1.0;
        let deviation = sample_std(&market_returns);
        let risk_score = if deviation > 1e-14 {
            mean(&market_returns) / deviation * (market_returns.len() as f64).sqrt()
        } else if momentum > 0.0 {
            1.0
        } else if momentum < 0.0 {
            -1.0
        } else {
            0.0
        };
        provisional.push((
            frame.dates[return_start].clone(),
            frame.dates[return_start - 1].clone(),
            return_start,
            (return_start + config.rebalance_every).min(frame.returns.len()),
            regime_state_index(risk_score, config.states.len()),
            risk_score,
            momentum,
            deviation * 252.0_f64.sqrt(),
            action_weights,
        ));
    }
    let retained_indices = valid_actions
        .iter()
        .enumerate()
        .filter_map(|(index, valid)| (*valid).then_some(index))
        .collect::<Vec<_>>();
    if retained_indices.is_empty() {
        bail!("no baseline action satisfies the regime policy constraints at every decision");
    }
    let effective_actions = retained_indices
        .iter()
        .map(|index| config.actions[*index].clone())
        .collect::<Vec<_>>();
    let removed_actions = config
        .actions
        .iter()
        .enumerate()
        .filter_map(|(index, action)| (!valid_actions[index]).then_some(action.clone()))
        .collect::<Vec<_>>();
    let warnings = if removed_actions.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "일부 국면 결정일에서 제약을 만족하지 못한 baseline action을 제외했습니다: {}",
            removed_actions.join(", ")
        )]
    };
    let decisions = provisional
        .into_iter()
        .map(
            |(
                date,
                signal_cutoff_date,
                return_start,
                return_end,
                state,
                risk_score,
                momentum,
                annualized_volatility,
                action_weights,
            )| RegimeDecision {
                date,
                signal_cutoff_date,
                return_start,
                return_end,
                state,
                risk_score,
                momentum,
                annualized_volatility,
                action_weights: retained_indices
                    .iter()
                    .map(|index| {
                        action_weights[*index]
                            .clone()
                            .expect("retained actions are available at every decision")
                    })
                    .collect(),
            },
        )
        .collect();
    Ok((decisions, effective_actions, warnings))
}

#[derive(Debug, Clone)]
struct EmpiricalPolicyModel {
    rewards: Vec<Vec<f64>>,
    transitions: Vec<Vec<f64>>,
    switching_costs: Vec<Vec<f64>>,
}

fn interval_log_growth(frame: &Frame, decision: &RegimeDecision, weights: &Weights) -> f64 {
    let dense = weights.dense(&frame.ids);
    frame.returns[decision.return_start..decision.return_end]
        .iter()
        .map(|row| {
            row.iter()
                .zip(&dense)
                .map(|(value, weight)| value * weight)
                .sum::<f64>()
        })
        .map(|value| (1.0 + value).max(1e-12).ln())
        .sum()
}

fn build_empirical_policy_model(
    frame: &Frame,
    decisions: &[RegimeDecision],
    training_count: usize,
    state_count: usize,
    action_count: usize,
    switching_cost_bps: f64,
) -> (EmpiricalPolicyModel, Vec<String>) {
    let training = &decisions[..training_count];
    let mut reward_sums = vec![vec![0.0; action_count]; state_count];
    let mut state_observations = vec![0usize; state_count];
    let mut global_reward_sums = vec![0.0; action_count];
    for decision in training {
        state_observations[decision.state] += 1;
        for (action, weights) in decision.action_weights.iter().enumerate() {
            let reward = interval_log_growth(frame, decision, weights);
            reward_sums[decision.state][action] += reward;
            global_reward_sums[action] += reward;
        }
    }
    let global_denominator = training.len().max(1) as f64;
    let global_rewards = global_reward_sums
        .iter()
        .map(|value| value / global_denominator)
        .collect::<Vec<_>>();
    let rewards = (0..state_count)
        .map(|state| {
            if state_observations[state] == 0 {
                global_rewards.clone()
            } else {
                reward_sums[state]
                    .iter()
                    .map(|value| value / state_observations[state] as f64)
                    .collect()
            }
        })
        .collect::<Vec<Vec<f64>>>();

    // A tiny symmetric prior keeps never-observed transitions well-defined without using OOS data.
    let mut transition_counts = vec![vec![1e-6; state_count]; state_count];
    for pair in training.windows(2) {
        transition_counts[pair[0].state][pair[1].state] += 1.0;
    }
    let transitions = transition_counts
        .into_iter()
        .map(|row| {
            let total = row.iter().sum::<f64>().max(1e-18);
            row.into_iter().map(|value| value / total).collect()
        })
        .collect::<Vec<Vec<f64>>>();

    let mut switching_costs = vec![vec![0.0; action_count]; action_count];
    let pair_count = training.len().saturating_sub(1);
    if pair_count > 0 && switching_cost_bps > 0.0 {
        for pair in training.windows(2) {
            for (previous, previous_weights) in pair[0].action_weights.iter().enumerate() {
                let previous_dense = previous_weights.dense(&frame.ids);
                for (action, weights) in pair[1].action_weights.iter().enumerate() {
                    let dense = weights.dense(&frame.ids);
                    let turnover = 0.5
                        * previous_dense
                            .iter()
                            .zip(dense)
                            .map(|(left, right)| (left - right).abs())
                            .sum::<f64>();
                    let cost = turnover * switching_cost_bps / 10_000.0;
                    switching_costs[previous][action] += -(1.0 - cost).max(1e-12).ln();
                }
            }
        }
        for row in &mut switching_costs {
            for cost in row {
                *cost /= pair_count as f64;
            }
        }
    }
    let warnings = state_observations
        .iter()
        .enumerate()
        .filter(|(_, observations)| **observations == 0)
        .map(|(state, _)| {
            format!(
                "훈련 구간에서 국면 index {state} 관측이 없어 전체 훈련 평균 보상을 사용했습니다."
            )
        })
        .collect();
    (
        EmpiricalPolicyModel {
            rewards,
            transitions,
            switching_costs,
        },
        warnings,
    )
}

fn policy_reward(
    model: &EmpiricalPolicyModel,
    state: usize,
    previous_action: usize,
    action: usize,
) -> f64 {
    let switching_cost = if previous_action < model.switching_costs.len() {
        model.switching_costs[previous_action][action]
    } else {
        0.0
    };
    model.rewards[state][action] - switching_cost
}

fn dynamic_programming_policy(
    model: &EmpiricalPolicyModel,
    max_depth: usize,
    discount: f64,
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Vec<usize>>> {
    let state_count = model.rewards.len();
    let action_count = model.rewards.first().map(Vec::len).unwrap_or(0);
    let previous_action_count = action_count + 1;
    let mut values = vec![vec![0.0; previous_action_count]; state_count];
    let mut policy = vec![vec![0usize; previous_action_count]; state_count];
    for depth in 0..max_depth {
        if depth.is_multiple_of(4) {
            checkpoint(control)?;
        }
        let mut next_values = vec![vec![0.0; previous_action_count]; state_count];
        for state in 0..state_count {
            for previous in 0..previous_action_count {
                let mut best_action = 0usize;
                let mut best_value = f64::NEG_INFINITY;
                for (action, _) in model.rewards[state].iter().enumerate() {
                    let continuation = model.transitions[state]
                        .iter()
                        .enumerate()
                        .map(|(next_state, probability)| probability * values[next_state][action])
                        .sum::<f64>();
                    let value =
                        policy_reward(model, state, previous, action) + discount * continuation;
                    if value > best_value {
                        best_value = value;
                        best_action = action;
                    }
                }
                policy[state][previous] = best_action;
                next_values[state][previous] = best_value;
            }
        }
        values = next_values;
    }
    Ok(policy)
}

#[derive(Debug, Clone, Copy, Default)]
struct MctsActionStat {
    visits: u64,
    value_sum: f64,
}

fn sample_transition(probabilities: &[f64], rng: &mut Mulberry32) -> usize {
    let target = rng.next();
    let mut cumulative = 0.0;
    for (index, probability) in probabilities.iter().enumerate() {
        cumulative += probability;
        if target <= cumulative || index + 1 == probabilities.len() {
            return index;
        }
    }
    0
}

fn mcts_policy(
    model: &EmpiricalPolicyModel,
    max_depth: usize,
    rollouts: usize,
    exploration_constant: f64,
    discount: f64,
    rng: &mut Mulberry32,
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Vec<usize>>> {
    let state_count = model.rewards.len();
    let action_count = model.rewards.first().map(Vec::len).unwrap_or(0);
    let previous_action_count = action_count + 1;
    let mut policy = vec![vec![0usize; previous_action_count]; state_count];
    for (root_state, policy_by_previous) in policy.iter_mut().enumerate() {
        for (root_previous, selected_policy) in policy_by_previous.iter_mut().enumerate() {
            let mut tree = BTreeMap::<(usize, usize, usize), Vec<MctsActionStat>>::new();
            for rollout in 0..rollouts {
                if rollout.is_multiple_of(64) {
                    checkpoint(control)?;
                }
                let mut state = root_state;
                let mut previous = root_previous;
                let mut path = Vec::<((usize, usize, usize), usize, f64)>::new();
                for depth in 0..max_depth {
                    let key = (depth, state, previous);
                    let stats = tree
                        .entry(key)
                        .or_insert_with(|| vec![MctsActionStat::default(); action_count]);
                    let total_visits = stats.iter().map(|stat| stat.visits).sum::<u64>();
                    let action = stats
                        .iter()
                        .position(|stat| stat.visits == 0)
                        .unwrap_or_else(|| {
                            stats
                                .iter()
                                .enumerate()
                                .max_by(|(left_index, left), (right_index, right)| {
                                    let score = |stat: &MctsActionStat| {
                                        stat.value_sum / stat.visits as f64
                                            + exploration_constant
                                                * ((total_visits.max(1) as f64).ln()
                                                    / stat.visits as f64)
                                                    .sqrt()
                                    };
                                    score(left)
                                        .total_cmp(&score(right))
                                        .then_with(|| right_index.cmp(left_index))
                                })
                                .map(|(index, _)| index)
                                .unwrap_or(0)
                        });
                    let reward = policy_reward(model, state, previous, action);
                    path.push((key, action, reward));
                    state = sample_transition(&model.transitions[state], rng);
                    previous = action;
                }
                let mut return_from_node = 0.0;
                for (key, action, reward) in path.into_iter().rev() {
                    return_from_node = reward + discount * return_from_node;
                    let stat = &mut tree
                        .get_mut(&key)
                        .expect("visited MCTS node remains in the tree")[action];
                    stat.visits += 1;
                    stat.value_sum += return_from_node;
                }
            }
            let root = tree
                .get(&(0, root_state, root_previous))
                .context("MCTS did not visit its root node")?;
            *selected_policy = root
                .iter()
                .enumerate()
                .max_by(|(left_index, left), (right_index, right)| {
                    left.visits
                        .cmp(&right.visits)
                        .then_with(|| {
                            let left_mean = left.value_sum / left.visits.max(1) as f64;
                            let right_mean = right.value_sum / right.visits.max(1) as f64;
                            left_mean.total_cmp(&right_mean)
                        })
                        .then_with(|| right_index.cmp(left_index))
                })
                .map(|(index, _)| index)
                .unwrap_or(0);
        }
    }
    Ok(policy)
}

fn follow_regime_policy(
    policy: &[Vec<usize>],
    decisions: &[RegimeDecision],
    action_count: usize,
) -> Vec<usize> {
    let mut previous = action_count;
    decisions
        .iter()
        .map(|decision| {
            let action = policy[decision.state][previous];
            previous = action;
            action
        })
        .collect()
}

fn constant_regime_policy(
    state_count: usize,
    action_count: usize,
    action: usize,
) -> Vec<Vec<usize>> {
    vec![vec![action; action_count + 1]; state_count]
}

fn policy_screening_metrics(
    frame: &Frame,
    decisions: &[RegimeDecision],
    actions: &[usize],
    annualization: f64,
    risk_free_percent: f64,
    transaction_cost_bps: f64,
) -> Value {
    let mut returns = Vec::<f64>::new();
    let mut dates = Vec::<String>::new();
    let mut previous_weights: Option<Vec<f64>> = None;
    let mut total_turnover = 0.0;
    let mut total_transaction_cost = 0.0;
    for (decision, action) in decisions.iter().zip(actions) {
        let dense = decision.action_weights[*action].dense(&frame.ids);
        let transaction_cost = previous_weights
            .as_ref()
            .map(|previous| {
                let turnover = 0.5
                    * previous
                        .iter()
                        .zip(&dense)
                        .map(|(left, right)| (left - right).abs())
                        .sum::<f64>();
                total_turnover += turnover;
                turnover * transaction_cost_bps / 10_000.0
            })
            .unwrap_or(0.0);
        total_transaction_cost += transaction_cost;
        for return_index in decision.return_start..decision.return_end {
            let mut portfolio_return = frame.returns[return_index]
                .iter()
                .zip(&dense)
                .map(|(value, weight)| value * weight)
                .sum::<f64>();
            if return_index == decision.return_start && transaction_cost > 0.0 {
                portfolio_return = (1.0 - transaction_cost) * (1.0 + portfolio_return) - 1.0;
            }
            returns.push(portfolio_return);
            dates.push(frame.dates[return_index].clone());
        }
        previous_weights = Some(dense);
    }
    let observations = returns.len();
    let cumulative = returns
        .iter()
        .fold(1.0, |growth, value| growth * (1.0 + value))
        - 1.0;
    let elapsed_years = dates
        .first()
        .zip(dates.last())
        .map(|(first, last)| {
            let days = crate::date::days_between(first, last);
            (1.0 / annualization).max((days as f64 + 365.25 / annualization) / 365.25)
        })
        .unwrap_or(0.0);
    let cagr = if 1.0 + cumulative > 0.0 && elapsed_years > 0.0 {
        (1.0 + cumulative).powf(1.0 / elapsed_years) - 1.0
    } else {
        f64::NAN
    };
    let deviation = sample_std(&returns);
    let volatility = (observations >= 2).then_some(deviation * annualization.sqrt());
    let risk_free_period = (1.0 + risk_free_percent / 100.0).powf(1.0 / annualization) - 1.0;
    let excess_mean = mean(
        &returns
            .iter()
            .map(|value| value - risk_free_period)
            .collect::<Vec<_>>(),
    );
    let sharpe = (deviation > 1e-14).then_some(excess_mean * annualization.sqrt() / deviation);
    let downside = if returns.is_empty() {
        0.0
    } else {
        (returns
            .iter()
            .map(|value| (value - risk_free_period).min(0.0).powi(2))
            .sum::<f64>()
            / returns.len() as f64)
            .sqrt()
    };
    let sortino = (downside > 1e-14).then_some(excess_mean * annualization.sqrt() / downside);
    let mut growth = 1.0;
    let mut peak: f64 = 1.0;
    let mut max_drawdown = 0.0_f64;
    for value in &returns {
        growth *= 1.0 + value;
        peak = peak.max(growth);
        max_drawdown = max_drawdown.min(growth / peak - 1.0);
    }
    let calmar = (max_drawdown < -1e-14 && cagr.is_finite()).then_some(cagr / max_drawdown.abs());
    let cvar = quantile_linear(&returns, 0.05).map(|threshold| {
        mean(
            &returns
                .iter()
                .copied()
                .filter(|value| *value <= threshold)
                .collect::<Vec<_>>(),
        )
    });
    let robust_components = [
        ("sharpe", sharpe.map(|value| (value / 2.0).tanh()), 0.30),
        ("sortino", sortino.map(|value| (value / 2.0).tanh()), 0.20),
        ("calmar", calmar.map(f64::tanh), 0.15),
        (
            "volatility",
            volatility.map(|value| 1.0 / (1.0 + value.max(0.0))),
            0.15,
        ),
        ("cvar", cvar.map(|value| 1.0 / (1.0 + value.abs())), 0.10),
        (
            "turnover",
            Some(1.0 / (1.0 + total_turnover.max(0.0))),
            0.10,
        ),
    ];
    let available_weight = robust_components
        .iter()
        .filter_map(|(_, value, weight)| value.map(|_| *weight))
        .sum::<f64>();
    let robust_score = (available_weight > 0.0).then(|| {
        robust_components
            .iter()
            .filter_map(|(_, value, weight)| value.map(|value| value * weight))
            .sum::<f64>()
            / available_weight
    });
    json!({
        "sampleCount": observations,
        "startDate": dates.first(),
        "endDate": dates.last(),
        "return": nullable(cumulative),
        "cagr": nullable(cagr),
        "volatility": volatility,
        "maxDrawdown": nullable(max_drawdown),
        "cvar": cvar,
        "sharpe": sharpe,
        "sortino": sortino,
        "calmar": calmar,
        "turnover": total_turnover,
        "transactionCost": total_transaction_cost,
        "robustScore": robust_score,
        "robustScoreDetail": {
            "score": robust_score,
            "configuredWeight": 1.0,
            "availableWeight": available_weight,
            "components": robust_components.into_iter().map(|(name, normalized, weight)| json!({
                "name": name,
                "normalized": normalized,
                "weight": weight,
                "available": normalized.is_some(),
                "contribution": normalized.unwrap_or(0.0) * weight,
            })).collect::<Vec<_>>(),
        },
    })
}

fn policy_action_map_json(policy: &[Vec<usize>], states: &[String], actions: &[String]) -> Value {
    let start = actions.len();
    Value::Object(
        states
            .iter()
            .enumerate()
            .map(|(state_index, state)| {
                let mut by_previous = Map::new();
                by_previous.insert(
                    "__start__".to_owned(),
                    json!(actions[policy[state_index][start]]),
                );
                for (previous, previous_name) in actions.iter().enumerate() {
                    by_previous.insert(
                        previous_name.clone(),
                        json!(actions[policy[state_index][previous]]),
                    );
                }
                (state.clone(), Value::Object(by_previous))
            })
            .collect(),
    )
}

fn policy_trace_json(
    decisions: &[RegimeDecision],
    selected_actions: &[usize],
    states: &[String],
    actions: &[String],
) -> Vec<Value> {
    decisions
        .iter()
        .zip(selected_actions)
        .map(|(decision, action)| {
            json!({
                "date": decision.date,
                "signalCutoffDate": decision.signal_cutoff_date,
                "state": states[decision.state],
                "stateIndex": decision.state,
                "action": actions[*action],
                "signal": {
                    "riskAdjustedMomentum": decision.risk_score,
                    "momentum": decision.momentum,
                    "annualizedVolatility": decision.annualized_volatility,
                },
                "weights": decision.action_weights[*action].to_json(),
            })
        })
        .collect()
}

fn policy_weights_for_template(
    template: &BacktestSimulationInput,
    frame_ids: &[String],
    weights: &Weights,
    cash_target_percent: f64,
) -> Result<(Vec<f64>, BTreeMap<String, f64>)> {
    let mut by_index = vec![0.0; template.assets.len()];
    let dense = weights.dense(frame_ids);
    let total = dense.iter().sum::<f64>();
    if total <= 0.0 || total > 1.0 + 1e-8 {
        bail!("regime policy weights cannot be applied to ledger template");
    }
    let invested_percent = 100.0 - cash_target_percent;
    for (id, weight) in frame_ids.iter().zip(dense) {
        if weight <= 1e-14 {
            continue;
        }
        let index = template_asset_index(template, id)?;
        by_index[index] += weight / total * invested_percent;
    }
    let mut by_symbol = BTreeMap::new();
    for (index, asset) in template.assets.iter().enumerate() {
        if by_symbol
            .insert(asset.symbol.clone(), by_index[index])
            .is_some()
        {
            bail!("regime policy ledger validation requires unique asset symbols");
        }
    }
    Ok((by_index, by_symbol))
}

fn ledger_input_for_regime_policy(
    template: &Value,
    frame: &Frame,
    decisions: &[RegimeDecision],
    selected_actions: &[usize],
    states: &[String],
    actions: &[String],
) -> Result<BacktestSimulationInput> {
    let mut input: BacktestSimulationInput = serde_json::from_value(template.clone())
        .context("invalid ledgerTemplate backtest simulation input")?;
    let frame_end = frame
        .dates
        .last()
        .context("regime policy frame has no dates")?;
    if input.end_date > *frame_end {
        input.end_date = frame_end.clone();
    }
    let selected = decisions
        .iter()
        .zip(selected_actions)
        .filter(|(decision, _)| {
            decision.date >= input.requested_start_date && decision.date <= input.end_date
        })
        .collect::<Vec<_>>();
    let (first_decision, first_action) = selected
        .first()
        .copied()
        .context("no OOS regime decision falls inside the ledger template period")?;
    input.requested_start_date = first_decision.date.clone();
    let cash_target_percent = input.execution.cash_target_percent.clamp(0.0, 99.0);
    let (initial_weights, _) = policy_weights_for_template(
        &input,
        &frame.ids,
        &first_decision.action_weights[*first_action],
        cash_target_percent,
    )?;
    for (asset, weight) in input.assets.iter_mut().zip(initial_weights) {
        asset.weight = weight;
    }
    input.execution.cash_target_percent = cash_target_percent;
    input.target_weight_schedule = selected
        .into_iter()
        .map(|(decision, action)| {
            let (_, weights) = policy_weights_for_template(
                &input,
                &frame.ids,
                &decision.action_weights[*action],
                cash_target_percent,
            )?;
            Ok(TargetWeightScheduleEntry {
                date: decision.date.clone(),
                weights,
                cash_target_percent,
                regime: Some(states[decision.state].clone()),
                action: Some(actions[*action].clone()),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(input)
}

fn regime_policy_candidate_json(
    candidate: &RegimePolicyCandidate,
    states: &[String],
    actions: &[String],
    trace_preview: &[Value],
) -> Value {
    json!({
        "id": candidate.id,
        "name": candidate.name,
        "candidateSource": candidate.source,
        "statePreviousActionMap": policy_action_map_json(&candidate.policy, states, actions),
        "trainingMetrics": candidate.training_metrics,
        "oosScreeningMetrics": candidate.oos_metrics,
        "screeningRank": candidate.screening_rank,
        "ledgerValidationStatus": candidate.validation_status,
        "validationError": candidate.validation_error,
        "ledgerMetrics": candidate.ledger_metrics,
        "ledgerRobustScoreDetail": candidate.ledger_robust_detail,
        "ledgerDataQuality": candidate.ledger_data_quality,
        "ledgerRank": candidate.ledger_rank,
        "rankChange": candidate.rank_change,
        "decisionTracePreview": trace_preview,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_regime_policy_search(
    frame: &Frame,
    config: &RegimePolicyConfig,
    optimizer_config: &OptimizerV2Config,
    constraints: &Constraints,
    annualization: f64,
    risk_free_percent: f64,
    transaction_cost_bps: f64,
    seed: u64,
    control: Option<&dyn ComputeControl>,
) -> Result<(Value, Value, Vec<String>)> {
    let (decisions, actions, mut warnings) =
        build_regime_decisions(frame, config, optimizer_config, constraints, control)?;
    if decisions.len() <= config.minimum_training_decisions {
        let warning = format!(
            "국면 정책 탐색 결정 수({})가 최소 훈련 결정 수({})와 OOS 1개를 충족하지 못했습니다.",
            decisions.len(),
            config.minimum_training_decisions
        );
        warnings.push(warning);
        return Ok((
            json!({
                "enabled": true,
                "status": "insufficient_data",
                "requestedMethod": config.requested_method.as_str(),
                "decisionCount": decisions.len(),
                "minimumTrainingDecisions": config.minimum_training_decisions,
                "states": config.states,
                "actions": actions,
                "warnings": warnings,
            }),
            json!([]),
            warnings,
        ));
    }
    let proposed_training = (decisions.len() as f64 * config.train_fraction).floor() as usize;
    let training_count = proposed_training
        .max(config.minimum_training_decisions)
        .min(decisions.len() - 1);
    let oos_decisions = &decisions[training_count..];
    let action_count = actions.len();
    let state_count = config.states.len();
    let (model, model_warnings) = build_empirical_policy_model(
        frame,
        &decisions,
        training_count,
        state_count,
        action_count,
        config.switching_cost_bps,
    );
    warnings.extend(model_warnings);
    let search_complexity = state_count
        .saturating_mul(action_count + 1)
        .saturating_mul(action_count)
        .saturating_mul(config.max_depth);
    let effective_method = match config.requested_method {
        RegimePolicyMethod::Auto if search_complexity > 30_000 => RegimePolicyMethod::Mcts,
        RegimePolicyMethod::Auto => RegimePolicyMethod::DynamicProgramming,
        method => method,
    };
    let adaptive_policy = match effective_method {
        RegimePolicyMethod::DynamicProgramming => {
            dynamic_programming_policy(&model, config.max_depth, config.discount, control)?
        }
        RegimePolicyMethod::Mcts => {
            let mut policy_rng = Mulberry32::new(seed ^ 0xA17C_9E37);
            mcts_policy(
                &model,
                config.max_depth,
                config.rollouts,
                config.exploration_constant,
                config.discount,
                &mut policy_rng,
                control,
            )?
        }
        RegimePolicyMethod::Auto => unreachable!("auto method is resolved before search"),
    };
    let mut policies = Vec::<(String, String, String, Vec<Vec<usize>>)>::new();
    policies.push((
        format!("adaptive:{}", effective_method.as_str()),
        format!("Adaptive {}", effective_method.as_str()),
        format!("regime_policy:{}", effective_method.as_str()),
        adaptive_policy,
    ));
    policies.extend(actions.iter().enumerate().map(|(action, name)| {
        (
            format!("constant:{name}"),
            format!("Constant {name}"),
            format!("regime_policy:baseline:{name}"),
            constant_regime_policy(state_count, action_count, action),
        )
    }));
    let mut candidates = policies
        .into_iter()
        .map(|(id, name, source, policy)| {
            let training_actions =
                follow_regime_policy(&policy, &decisions[..training_count], action_count);
            let oos_actions = follow_regime_policy(&policy, oos_decisions, action_count);
            let training_metrics = policy_screening_metrics(
                frame,
                &decisions[..training_count],
                &training_actions,
                annualization,
                risk_free_percent,
                transaction_cost_bps,
            );
            let oos_metrics = policy_screening_metrics(
                frame,
                oos_decisions,
                &oos_actions,
                annualization,
                risk_free_percent,
                transaction_cost_bps,
            );
            RegimePolicyCandidate {
                id,
                name,
                source,
                policy,
                training_actions,
                oos_actions,
                training_metrics,
                oos_metrics,
                screening_rank: 0,
                validation_status: if optimizer_config.ledger_template.is_some() {
                    "not_selected".to_owned()
                } else {
                    "not_requested".to_owned()
                },
                validation_error: None,
                ledger_metrics: None,
                ledger_robust_detail: None,
                ledger_data_quality: None,
                ledger_rank: None,
                rank_change: None,
            }
        })
        .collect::<Vec<_>>();
    let screening_score = |candidate: &RegimePolicyCandidate| {
        candidate
            .oos_metrics
            .get("robustScore")
            .and_then(Value::as_f64)
    };
    candidates.sort_by(
        |left, right| match (screening_score(left), screening_score(right)) {
            (Some(left), Some(right)) => right.total_cmp(&left),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => left.id.cmp(&right.id),
        },
    );
    for (rank, candidate) in candidates.iter_mut().enumerate() {
        candidate.screening_rank = rank + 1;
    }

    let mut selected = candidates
        .iter()
        .position(|candidate| candidate.id.starts_with("adaptive:"))
        .into_iter()
        .collect::<Vec<_>>();
    for index in 0..candidates.len() {
        if selected.len() >= config.ledger_validation_budget {
            break;
        }
        if !selected.contains(&index) {
            selected.push(index);
        }
    }
    let mut failed_count = 0usize;
    let mut completed = Vec::<usize>::new();
    if let Some(template) = optimizer_config.ledger_template.as_ref() {
        for (position, index) in selected.iter().copied().enumerate() {
            if position.is_multiple_of(2) {
                checkpoint(control)?;
            }
            let validation = ledger_input_for_regime_policy(
                template,
                frame,
                oos_decisions,
                &candidates[index].oos_actions,
                &config.states,
                &actions,
            )
            .and_then(|ledger_input| {
                backtest::simulate_with_control(&ledger_input, control)
                    .context("regime policy ledger validation backtest failed")
            });
            match validation {
                Ok(result) => {
                    let (metrics, robust_detail) =
                        ledger_metrics(&result, &optimizer_config.robust_weights);
                    candidates[index].validation_status = "completed".to_owned();
                    candidates[index].ledger_metrics = Some(metrics);
                    candidates[index].ledger_robust_detail = Some(robust_detail);
                    candidates[index].ledger_data_quality =
                        Some(serde_json::to_value(&result.data_quality)?);
                    completed.push(index);
                }
                Err(error) => {
                    failed_count += 1;
                    candidates[index].validation_status = "failed".to_owned();
                    candidates[index].validation_error = Some(error.to_string());
                }
            }
        }
        completed.sort_by(|left, right| {
            let score = |index: usize| {
                candidates[index]
                    .ledger_metrics
                    .as_ref()
                    .and_then(|metrics| metrics.get("robustScore"))
                    .and_then(Value::as_f64)
            };
            match (score(*left), score(*right)) {
                (Some(left), Some(right)) => right.total_cmp(&left),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => candidates[*left].id.cmp(&candidates[*right].id),
            }
        });
        for (rank, index) in completed.iter().copied().enumerate() {
            candidates[index].ledger_rank = Some(rank + 1);
            candidates[index].rank_change =
                Some(candidates[index].screening_rank as i64 - (rank + 1) as i64);
        }
    } else {
        warnings.push(
            "ledgerTemplate이 없어 국면 정책 후보는 screening까지만 수행했습니다.".to_owned(),
        );
    }
    if failed_count > 0 {
        warnings.push(format!(
            "국면 정책 ledger 재검증 후보 {failed_count}개가 실패했습니다. 후보별 validationError를 확인하세요."
        ));
    }
    warnings.push(
        "국면 정책은 훈련 구간의 역사적 상태 전이와 보상에 적합화되며 미래 성과를 보장하지 않습니다."
            .to_owned(),
    );

    let best_index = completed.first().copied().unwrap_or(0);
    let summaries = candidates
        .iter()
        .map(|candidate| {
            let trace = policy_trace_json(
                oos_decisions,
                &candidate.oos_actions,
                &config.states,
                &actions,
            );
            regime_policy_candidate_json(
                candidate,
                &config.states,
                &actions,
                &trace.into_iter().take(20).collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    let artifact = candidates
        .iter()
        .map(|candidate| {
            let training_trace = policy_trace_json(
                &decisions[..training_count],
                &candidate.training_actions,
                &config.states,
                &actions,
            );
            let oos_trace = policy_trace_json(
                oos_decisions,
                &candidate.oos_actions,
                &config.states,
                &actions,
            );
            json!({
                "policy": regime_policy_candidate_json(
                    candidate,
                    &config.states,
                    &actions,
                    &[],
                ),
                "trainingDecisionTrace": training_trace,
                "oosDecisionTrace": oos_trace,
            })
        })
        .collect::<Vec<_>>();
    let training_end_return = decisions[training_count - 1].return_end.saturating_sub(1);
    let oos_observations = candidates[best_index]
        .oos_metrics
        .get("sampleCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let ledger_status = if optimizer_config.ledger_template.is_none() {
        "not_requested"
    } else if completed.is_empty() {
        "failed"
    } else if failed_count > 0 {
        "partial"
    } else {
        "completed"
    };
    let status = if optimizer_config.ledger_template.is_none() {
        "screening_only"
    } else {
        ledger_status
    };
    let reward_model = Value::Object(
        config
            .states
            .iter()
            .enumerate()
            .map(|(state, name)| {
                (
                    name.clone(),
                    Value::Object(
                        actions
                            .iter()
                            .enumerate()
                            .map(|(action, name)| {
                                (name.clone(), json!(model.rewards[state][action]))
                            })
                            .collect(),
                    ),
                )
            })
            .collect(),
    );
    let transition_model = Value::Object(
        config
            .states
            .iter()
            .enumerate()
            .map(|(state, name)| {
                (
                    name.clone(),
                    Value::Object(
                        config
                            .states
                            .iter()
                            .enumerate()
                            .map(|(next, name)| {
                                (name.clone(), json!(model.transitions[state][next]))
                            })
                            .collect(),
                    ),
                )
            })
            .collect(),
    );
    let summary = json!({
        "enabled": true,
        "status": status,
        "requestedMethod": config.requested_method.as_str(),
        "effectiveMethod": effective_method.as_str(),
        "implementation": if effective_method == RegimePolicyMethod::Mcts {
            "uct_tree_search_empirical_markov_model"
        } else {
            "finite_horizon_bellman_dynamic_programming"
        },
        "deterministic": true,
        "seed": seed,
        "states": config.states,
        "actions": actions,
        "decisionCount": decisions.len(),
        "trainingDecisionCount": training_count,
        "oosDecisionCount": oos_decisions.len(),
        "oosCoverage": oos_observations as f64 / frame.returns.len().max(1) as f64,
        "config": {
            "lookback": config.lookback,
            "rebalanceEvery": config.rebalance_every,
            "trainFraction": config.train_fraction,
            "minimumTrainingDecisions": config.minimum_training_decisions,
            "maxDepth": config.max_depth,
            "rollouts": config.rollouts,
            "explorationConstant": config.exploration_constant,
            "discount": config.discount,
            "switchingCostBps": config.switching_cost_bps,
            "ledgerValidationBudget": config.ledger_validation_budget,
            "autoSearchComplexity": search_complexity,
            "autoMctsThreshold": 30_000,
        },
        "noLookahead": {
            "stateClassifier": "equal_weight_market_risk_adjusted_momentum_fixed_boundaries",
            "stateBoundaries": "fixed_equal_width_bins_over_clipped_minus_one_to_one_signal",
            "signalWindow": "rolling_past_only",
            "signalCutoff": "strictly_before_decision_date",
            "actionCovarianceWindow": "rolling_past_only",
            "policyFit": "training_decisions_only",
            "policyFrozenForOos": true,
            "trainingStartDate": decisions.first().map(|decision| &decision.date),
            "trainingEndDate": frame.dates.get(training_end_return),
            "oosStartDate": oos_decisions.first().map(|decision| &decision.date),
        },
        "empiricalModel": {
            "stateActionMeanLogRewards": reward_model,
            "transitionProbabilities": transition_model,
            "transitionPrior": 1e-6,
            "switchingCostsIncluded": config.switching_cost_bps > 0.0,
        },
        "policies": summaries,
        "bestPolicy": summaries.get(best_index),
        "ledgerValidation": {
            "status": ledger_status,
            "budget": config.ledger_validation_budget,
            "selectedCount": if optimizer_config.ledger_template.is_some() { selected.len() } else { 0 },
            "completedCount": completed.len(),
            "failedCount": failed_count,
            "selectionPolicy": "adaptive_then_oos_screening_rank",
            "rankingMetric": "ledger_robust_score",
        },
        "warnings": warnings,
    });
    Ok((summary, Value::Array(artifact), warnings))
}

fn validate_with_ledger(
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
