use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};

use crate::portfolio_math::CovarianceEstimator;

use super::input::{decimal, numeric, positive_int, unique_strings};
use super::regime_policy::{RegimePolicyConfig, RegimePolicyMethod};
use super::{
    Algorithm, BASELINE_NAMES, DEFAULT_LEDGER_VALIDATION_BUDGET, GroupConstraint, OptimizerV2Config,
};

pub(super) fn default_robust_weights() -> BTreeMap<String, f64> {
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

pub(super) fn parse_asset_groups(
    value: Option<&Value>,
) -> BTreeMap<String, BTreeMap<String, String>> {
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

pub(super) fn parse_group_constraints(value: Option<&Value>) -> Result<Vec<GroupConstraint>> {
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

pub(super) fn parse_v2_config(input: &Map<String, Value>) -> Result<OptimizerV2Config> {
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

pub(super) fn parse_regime_policy_config(
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
