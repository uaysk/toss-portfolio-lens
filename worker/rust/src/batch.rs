use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use rayon::prelude::*;
use serde_json::{Map, Value, json};

use crate::backtest;
use crate::contracts::JobKind;
use crate::control::{ComputeControl, checkpoint};
use crate::model::BacktestSimulationInput;
use crate::stats::{average, round, sample_std};

#[derive(Clone)]
struct PriceSeries {
    key: String,
    label: String,
    points: Vec<(String, f64)>,
}

fn scenario_compute(
    index: usize,
    scenario: &Value,
    control: Option<&dyn ComputeControl>,
) -> Result<Value> {
    checkpoint(control)?;
    let object = scenario
        .as_object()
        .context("each scenario must be an object")?;
    let input: BacktestSimulationInput = serde_json::from_value(
        object
            .get("simulation")
            .context("scenario.simulation is required")?
            .clone(),
    )
    .context("invalid scenario simulation")?;
    let result = backtest::simulate_with_control(&input, control)?;
    let metrics = serde_json::to_value(&result.metrics)?;
    let cvar = result
        .advanced
        .pointer("/tailRisk/expectedShortfall95Percent")
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "id": object.get("id").cloned().unwrap_or_else(|| json!(format!("scenario-{}", index + 1))),
        "name": object.get("name").or_else(|| object.get("label")).cloned().unwrap_or_else(|| json!(format!("Scenario {}", index + 1))),
        "label": object.get("label").or_else(|| object.get("name")).cloned().unwrap_or_else(|| json!(format!("Scenario {}", index + 1))),
        "config": object.get("config").cloned().unwrap_or(Value::Null),
        "metrics": metrics,
        "cvar95Percent": cvar,
        "effectivePeriod": {"from": result.effective_start_date, "to": result.end_date},
        "dataQuality": result.data_quality,
        "tradeCount": result.trades.len(),
        "cashFlowCount": result.cash_flows.len(),
    }))
}

fn cvar(returns: &[f64], confidence: f64) -> Option<f64> {
    if returns.is_empty() {
        return None;
    }
    let mut sorted = returns
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(f64::total_cmp);
    let count = ((sorted.len() as f64 * (1.0 - confidence)).ceil() as usize)
        .max(1)
        .min(sorted.len());
    Some(sorted[..count].iter().sum::<f64>() / count as f64)
}

fn metric(scenario: &Value, name: &str) -> Option<f64> {
    scenario
        .pointer(&format!("/metrics/{name}"))
        .and_then(Value::as_f64)
        .or_else(|| {
            (name == "cvar95Percent")
                .then(|| scenario.get(name).and_then(Value::as_f64))
                .flatten()
        })
}

fn distribution(scenarios: &[Value], name: &str) -> Value {
    let mut values = scenarios
        .iter()
        .filter_map(|scenario| metric(scenario, name))
        .collect::<Vec<_>>();
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return Value::Null;
    }
    let median = if values.len() % 2 == 1 {
        values[values.len() / 2]
    } else {
        (values[values.len() / 2 - 1] + values[values.len() / 2]) / 2.0
    };
    json!({
        "min": round(values[0], 6),
        "median": round(median, 6),
        "max": round(*values.last().unwrap(), 6),
    })
}

fn scenarios(
    kind: JobKind,
    payload: &Value,
    control: Option<&dyn ComputeControl>,
) -> Result<Value> {
    checkpoint(control)?;
    let list = payload
        .get("scenarios")
        .and_then(Value::as_array)
        .context("payload.scenarios must be an array")?;
    ensure!(!list.is_empty(), "at least one scenario is required");
    ensure!(list.len() <= 500, "scenario count exceeds 500");
    let computed = list
        .par_iter()
        .enumerate()
        .map(|(index, scenario)| scenario_compute(index, scenario, control))
        .collect::<Result<Vec<_>>>()?;
    checkpoint(control)?;
    let mut warnings = payload
        .get("market_warnings")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if kind == JobKind::StressTest && computed.len() < 2 {
        warnings.push("스트레스 비교가 단일 시나리오이므로 상대 비교 해석에 주의하세요.".into());
    }
    let worst = computed
        .iter()
        .min_by(|left, right| {
            metric(left, "totalReturnPercent")
                .unwrap_or(f64::INFINITY)
                .total_cmp(&metric(right, "totalReturnPercent").unwrap_or(f64::INFINITY))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let distributions = json!({
        "totalReturnPercent": distribution(&computed, "totalReturnPercent"),
        "cagrPercent": distribution(&computed, "cagrPercent"),
        "annualizedVolatilityPercent": distribution(&computed, "annualizedVolatilityPercent"),
        "maxDrawdownPercent": distribution(&computed, "maxDrawdownPercent"),
        "sharpeRatio": distribution(&computed, "sharpeRatio"),
        "moneyWeightedReturnPercent": distribution(&computed, "moneyWeightedReturnPercent"),
        "cvar95Percent": distribution(&computed, "cvar95Percent"),
        "totalTransactionCosts": distribution(&computed, "totalTransactionCosts"),
    });
    Ok(json!({
        "kind": serde_json::to_value(kind)?,
        "scenarioCount": computed.len(),
        "baselineScenarioId": computed.first().and_then(|value| value.get("id")).cloned().unwrap_or(Value::Null),
        "scenarios": computed,
        "distributions": distributions,
        "worstScenario": worst,
        "summary": {"scenario_count": list.len(), "worst": worst},
        "warnings": warnings,
    }))
}

fn parse_price_series(value: &Value) -> Result<Vec<PriceSeries>> {
    let list = value
        .as_array()
        .context("optimization.priceSeries must be an array")?;
    list.iter()
        .map(|series| {
            let object = series
                .as_object()
                .context("price series must be an object")?;
            let key = object
                .get("key")
                .and_then(Value::as_str)
                .context("price series key is required")?
                .to_owned();
            let label = object
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(&key)
                .to_owned();
            let mut by_date = BTreeMap::new();
            for point in object
                .get("points")
                .and_then(Value::as_array)
                .context("price series points must be an array")?
            {
                let date = point
                    .get("date")
                    .and_then(Value::as_str)
                    .context("price point date is required")?;
                let price = point
                    .get("value")
                    .and_then(Value::as_f64)
                    .context("price point value is required")?;
                if price.is_finite() && price > 0.0 {
                    by_date.insert(date.to_owned(), price);
                }
            }
            Ok(PriceSeries {
                key,
                label,
                points: by_date.into_iter().collect(),
            })
        })
        .collect()
}

fn common_dates(series: &[PriceSeries]) -> Vec<String> {
    let mut dates = series
        .first()
        .map(|item| {
            item.points
                .iter()
                .map(|(date, _)| date.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    for item in series.iter().skip(1) {
        let current = item
            .points
            .iter()
            .map(|(date, _)| date.clone())
            .collect::<BTreeSet<_>>();
        dates.retain(|date| current.contains(date));
    }
    dates.into_iter().collect()
}

fn sliced_price_series(series: &[PriceSeries], start: &str, end: &str) -> Value {
    Value::Array(series.iter().map(|item| json!({
        "key": item.key,
        "label": item.label,
        "points": item.points.iter().filter(|(date, _)| date.as_str() >= start && date.as_str() <= end)
            .map(|(date, value)| json!({"date": date, "value": value})).collect::<Vec<_>>(),
    })).collect())
}

fn aligned_returns(
    series: &[PriceSeries],
    dates: &[String],
    weights: &Map<String, Value>,
    start: usize,
    end: usize,
) -> Vec<f64> {
    let maps = series
        .iter()
        .map(|item| item.points.iter().cloned().collect::<BTreeMap<_, _>>())
        .collect::<Vec<_>>();
    (start..=end)
        .filter_map(|index| {
            if index + 1 >= dates.len() {
                return None;
            }
            let mut value = 0.0;
            for (asset_index, item) in series.iter().enumerate() {
                let weight = weights
                    .get(&item.key)
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let previous = *maps[asset_index].get(&dates[index])?;
                let current = *maps[asset_index].get(&dates[index + 1])?;
                value += weight * (current / previous - 1.0);
            }
            value.is_finite().then_some(value)
        })
        .collect()
}

fn oos_metrics(returns: &[f64], turnover: f64, transaction_cost: f64) -> Value {
    let total = returns.iter().fold(1.0, |value, item| value * (1.0 + item)) - 1.0;
    let mean = average(returns);
    let volatility = (returns.len() > 1).then(|| sample_std(returns) * 252.0_f64.sqrt());
    let sharpe = volatility
        .filter(|value| *value > 0.0)
        .map(|value| mean * 252.0 / value);
    let mut nav = 1.0_f64;
    let mut peak = 1.0_f64;
    let mut max_drawdown = 0.0_f64;
    for item in returns {
        nav *= 1.0 + item;
        peak = peak.max(nav);
        max_drawdown = max_drawdown.min(nav / peak - 1.0);
    }
    json!({
        "sampleCount": returns.len(),
        "return": round(total, 10),
        "totalReturnPercent": round(total * 100.0, 6),
        "volatility": volatility.map(|value| round(value, 10)),
        "annualizedVolatilityPercent": volatility.map(|value| round(value * 100.0, 6)),
        "sharpe": sharpe.map(|value| round(value, 10)),
        "maxDrawdown": round(max_drawdown, 10),
        "maxDrawdownPercent": round(max_drawdown * 100.0, 6),
        "cvar": cvar(returns, 0.95).map(|value| round(value, 10)),
        "cvar95Percent": cvar(returns, 0.95).map(|value| round(value * 100.0, 6)),
        "turnover": round(turnover, 10),
        "transactionCost": round(transaction_cost, 10),
    })
}

fn weight_turnover(
    series: &[PriceSeries],
    current: &Map<String, Value>,
    target: &Map<String, Value>,
) -> f64 {
    let current_sum = series
        .iter()
        .map(|item| {
            current
                .get(&item.key)
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        })
        .sum::<f64>();
    let target_sum = series
        .iter()
        .map(|item| target.get(&item.key).and_then(Value::as_f64).unwrap_or(0.0))
        .sum::<f64>();
    let asset_turnover = series
        .iter()
        .map(|item| {
            (target.get(&item.key).and_then(Value::as_f64).unwrap_or(0.0)
                - current
                    .get(&item.key)
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0))
            .abs()
        })
        .sum::<f64>();
    0.5 * (asset_turnover + ((1.0 - target_sum) - (1.0 - current_sum)).abs())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WalkForwardMode {
    Rolling,
    Anchored,
}

impl WalkForwardMode {
    fn parse(value: Option<&Value>) -> Result<Self> {
        match value.and_then(Value::as_str).unwrap_or("rolling") {
            "rolling" => Ok(Self::Rolling),
            "anchored" => Ok(Self::Anchored),
            other => bail!("unsupported walk-forward mode: {other}"),
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Rolling => "rolling",
            Self::Anchored => "anchored",
        }
    }
}

#[derive(Clone, Debug)]
struct ValidationWindow {
    train_start: usize,
    train_end: usize,
    test_start: usize,
    test_end: usize,
    gap: usize,
    embargo: usize,
    mode: WalkForwardMode,
}

fn config_usize(
    config: &Map<String, Value>,
    key: &str,
    fallback: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize> {
    let value = config
        .get(key)
        .map(|value| {
            value
                .as_u64()
                .with_context(|| format!("walkForwardConfig.{key} must be a non-negative integer"))
        })
        .transpose()?
        .unwrap_or(fallback as u64);
    let value = usize::try_from(value).context("walk-forward integer exceeds platform limits")?;
    ensure!(
        (minimum..=maximum).contains(&value),
        "walkForwardConfig.{key} must be between {minimum} and {maximum}"
    );
    Ok(value)
}

fn validation_windows(
    total_returns: usize,
    config: &Map<String, Value>,
) -> Result<Vec<ValidationWindow>> {
    let train = config_usize(config, "trainWindow", 126, 2, 10_000)?;
    let test = config_usize(config, "testWindow", 42, 1, 10_000)?;
    let step = config_usize(config, "step", test, 1, 10_000)?;
    let gap = config_usize(config, "gap", 0, 0, 10_000)?;
    let embargo = config_usize(config, "embargo", 0, 0, 10_000)?;
    let minimum_train = config_usize(
        config,
        "minimumTrainObservations",
        (train / 2).max(2),
        1,
        train,
    )?;
    let minimum_test = config_usize(
        config,
        "minimumTestObservations",
        (test / 2).max(1),
        1,
        test,
    )?;
    let mode = WalkForwardMode::parse(config.get("mode"))?;
    let Some(mut test_start) = train.checked_add(gap) else {
        bail!("walk-forward trainWindow + gap overflowed");
    };
    let advance = step.max(test.saturating_add(embargo));
    let mut windows = Vec::new();
    while test_start < total_returns {
        let Some(test_end) = test_start.checked_add(test.saturating_sub(1)) else {
            break;
        };
        if test_end >= total_returns {
            break;
        }
        let Some(train_end) = test_start.checked_sub(gap + 1) else {
            break;
        };
        let train_start = match mode {
            WalkForwardMode::Rolling => train_end.saturating_add(1).saturating_sub(train),
            WalkForwardMode::Anchored => 0,
        };
        let train_count = train_end - train_start + 1;
        let test_count = test_end - test_start + 1;
        if train_count >= minimum_train && test_count >= minimum_test {
            windows.push(ValidationWindow {
                train_start,
                train_end,
                test_start,
                test_end,
                gap,
                embargo,
                mode,
            });
        }
        let Some(next) = test_start.checked_add(advance) else {
            break;
        };
        test_start = next;
    }
    Ok(windows)
}

fn benchmark_returns(
    benchmark: &PriceSeries,
    dates: &[String],
    start: usize,
    end: usize,
) -> Option<Vec<f64>> {
    let prices = benchmark.points.iter().cloned().collect::<BTreeMap<_, _>>();
    (start..=end)
        .map(|index| {
            let previous = prices.get(&dates[index])?;
            let current = prices.get(&dates[index + 1])?;
            let value = current / previous - 1.0;
            value.is_finite().then_some(value)
        })
        .collect()
}

fn objective_metric(candidate: &Value, objective: &str) -> Option<f64> {
    let key = match objective {
        "max_sharpe" => "sharpe",
        "max_sortino" => "sortino",
        "max_calmar" => "calmar",
        "min_volatility" => "volatility",
        "min_cvar" => "cvar",
        "max_information_ratio" => "informationRatio",
        "robust_score" => "robustScore",
        _ => return None,
    };
    candidate
        .get("metrics")
        .and_then(|metrics| metrics.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn candidate_is_better(left: &Value, right: &Value, objective: &str) -> bool {
    let (Some(left), Some(right)) = (
        objective_metric(left, objective),
        objective_metric(right, objective),
    ) else {
        return false;
    };
    match objective {
        "min_volatility" => left < right,
        "min_cvar" => left.abs() < right.abs(),
        _ => left > right,
    }
}

fn seed_weight_stability(series: &[PriceSeries], weights: &[Map<String, Value>]) -> Value {
    let mut distances = Vec::new();
    for left in 0..weights.len() {
        for right in left + 1..weights.len() {
            distances.push(weight_turnover(series, &weights[left], &weights[right]));
        }
    }
    let mut by_asset = Map::new();
    for item in series {
        let values = weights
            .iter()
            .map(|value| value.get(&item.key).and_then(Value::as_f64).unwrap_or(0.0))
            .collect::<Vec<_>>();
        by_asset.insert(
            item.key.clone(),
            json!({
                "mean": round(average(&values), 10),
                "standardDeviation": (values.len() > 1).then(|| round(sample_std(&values), 10)),
            }),
        );
    }
    let mean_pairwise_weight_distance = if distances.is_empty() {
        0.0
    } else {
        round(average(&distances), 10)
    };
    json!({
        "seedCount": weights.len(),
        "meanPairwiseWeightDistance": mean_pairwise_weight_distance,
        "maxPairwiseWeightDistance": distances.iter().copied().max_by(f64::total_cmp).map(|value| round(value, 10)).unwrap_or(0.0),
        "byAsset": by_asset,
    })
}

fn stitched_oos_metrics(returns: &[f64], benchmark: Option<&[f64]>) -> Value {
    if returns.is_empty() {
        return Value::Null;
    }
    let growth = returns.iter().fold(1.0, |value, item| value * (1.0 + item));
    let cagr = if growth <= 0.0 {
        -1.0
    } else {
        growth.powf(252.0 / returns.len() as f64) - 1.0
    };
    let standard_deviation = (returns.len() > 1).then(|| sample_std(returns));
    let sharpe = standard_deviation
        .filter(|value| *value > 0.0)
        .map(|value| average(returns) / value * 252.0_f64.sqrt());
    let mut equity = 1.0_f64;
    let mut peak = 1.0_f64;
    let mut max_drawdown = 0.0_f64;
    for item in returns {
        equity *= 1.0 + item;
        peak = peak.max(equity);
        max_drawdown = max_drawdown.min(equity / peak - 1.0);
    }
    let information_ratio = benchmark.and_then(|values| {
        (values.len() == returns.len() && values.len() > 1).then(|| {
            let active = returns
                .iter()
                .zip(values)
                .map(|(portfolio, benchmark)| portfolio - benchmark)
                .collect::<Vec<_>>();
            let tracking_error = sample_std(&active);
            (tracking_error > 0.0).then(|| average(&active) / tracking_error * 252.0_f64.sqrt())
        })?
    });
    json!({
        "cagr": round(cagr, 10),
        "cagrPercent": round(cagr * 100.0, 6),
        "maxDrawdown": round(max_drawdown, 10),
        "maxDrawdownPercent": round(max_drawdown * 100.0, 6),
        "sharpe": sharpe.map(|value| round(value, 10)),
        "informationRatio": information_ratio.map(|value| round(value, 10)),
    })
}

fn walk_forward(payload: &Value, control: Option<&dyn ComputeControl>) -> Result<Value> {
    checkpoint(control)?;
    let optimization = payload
        .get("optimization")
        .context("walk-forward optimization input is required")?;
    let optimization_object = optimization
        .as_object()
        .context("optimization input must be an object")?;
    let series = parse_price_series(
        optimization_object
            .get("priceSeries")
            .context("priceSeries is required")?,
    )?;
    ensure!(
        series.len() >= 2,
        "walk-forward requires at least two assets"
    );
    let dates = common_dates(&series);
    ensure!(
        dates.len() >= 3,
        "walk-forward requires at least three common price observations"
    );
    let empty_config = Value::Object(Map::new());
    let config_value = payload
        .get("walkForwardConfig")
        .or_else(|| optimization.get("walkForwardConfig"))
        .unwrap_or(&empty_config);
    let config = config_value
        .as_object()
        .context("walkForwardConfig must be an object")?;
    let windows = validation_windows(dates.len() - 1, config)?;
    ensure!(
        !windows.is_empty(),
        "walk-forward configuration produced no validation folds"
    );
    let objective = payload
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or("robust_score");
    let total_budget = optimization
        .get("candidateBudget")
        .and_then(Value::as_u64)
        .unwrap_or(500) as usize;
    let base_seed = optimization
        .get("seed")
        .and_then(Value::as_u64)
        .unwrap_or(12_345);
    let mut seeds = config
        .get("seeds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value
                        .as_u64()
                        .context("walkForwardConfig.seeds must contain integers")
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_else(|| vec![base_seed]);
    let mut seen_seeds = BTreeSet::new();
    seeds.retain(|seed| seen_seeds.insert(*seed));
    ensure!(
        !seeds.is_empty() && seeds.len() <= 20,
        "walkForwardConfig.seeds must contain between 1 and 20 unique seeds"
    );
    let explicit_fold_budget = config
        .get("foldCandidateBudget")
        .map(|value| {
            value
                .as_u64()
                .context("walkForwardConfig.foldCandidateBudget must be a positive integer")
                .and_then(|value| {
                    usize::try_from(value).context("foldCandidateBudget exceeds platform limits")
                })
        })
        .transpose()?;
    if explicit_fold_budget.is_none() {
        ensure!(
            total_budget >= windows.len(),
            "candidateBudget must be at least the walk-forward fold count ({})",
            windows.len()
        );
    }
    let fold_budgets = (0..windows.len())
        .map(|index| {
            explicit_fold_budget.unwrap_or_else(|| {
                total_budget / windows.len() + usize::from(index < total_budget % windows.len())
            })
        })
        .collect::<Vec<_>>();
    ensure!(
        fold_budgets
            .iter()
            .all(|budget| *budget >= seeds.len() && *budget <= 10_000),
        "each fold candidate budget must be between the seed count ({}) and 10000",
        seeds.len()
    );
    let transaction_cost_bps = optimization
        .get("transactionCostBps")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 500.0);
    let mut previous_weights = optimization_object
        .get("constraints")
        .and_then(Value::as_object)
        .and_then(|constraints| constraints.get("currentWeights"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let benchmark = if let Some(value) = optimization_object
        .get("benchmarkPriceSeries")
        .or_else(|| optimization_object.get("benchmark_price_series"))
        .or_else(|| optimization_object.get("benchmark"))
        .filter(|value| value.is_object())
    {
        let parsed = parse_price_series(&Value::Array(vec![value.clone()]))?;
        parsed.into_iter().next()
    } else {
        None
    };
    let mut folds = Vec::with_capacity(windows.len());
    let mut stitched_returns = Vec::<f64>::new();
    let mut stitched_dates = Vec::<String>::new();
    let mut stitched_benchmark_returns = Vec::<f64>::new();
    let mut benchmark_complete = benchmark.is_some();
    let mut benchmark_fold_wins = Vec::<bool>::new();
    let mut total_turnover = 0.0;
    let mut total_transaction_cost = 0.0;
    let mut fold_seed_distances = Vec::<f64>::new();
    for (index, window) in windows.iter().enumerate() {
        checkpoint(control)?;
        ensure!(
            window.test_end < dates.len() - 1,
            "walk-forward window exceeds price observations"
        );
        let fold_budget = fold_budgets[index];
        let mut seed_runs = Vec::with_capacity(seeds.len());
        let mut seed_weights = Vec::<Map<String, Value>>::new();
        let mut selected: Option<(Value, Map<String, Value>, u64)> = None;
        let mut fold_candidate_count = 0_u64;
        for (seed_index, configured_seed) in seeds.iter().copied().enumerate() {
            checkpoint(control)?;
            let seed_budget =
                fold_budget / seeds.len() + usize::from(seed_index < fold_budget % seeds.len());
            let effective_seed = configured_seed.wrapping_add(index as u64);
            let mut training = optimization_object.clone();
            training.insert(
                "priceSeries".into(),
                sliced_price_series(
                    &series,
                    &dates[window.train_start],
                    &dates[window.train_end + 1],
                ),
            );
            training.insert("candidateBudget".into(), json!(seed_budget));
            training.insert("seed".into(), json!(effective_seed));
            let mut constraints = training
                .get("constraints")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            constraints.insert(
                "currentWeights".into(),
                Value::Object(previous_weights.clone()),
            );
            training.insert("constraints".into(), Value::Object(constraints));
            let optimized =
                crate::optimization::optimize_with_control(&Value::Object(training), control)?;
            let candidate_count = optimized
                .get("candidateCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            fold_candidate_count += candidate_count;
            let best = optimized
                .pointer(&format!("/bestByObjective/{objective}"))
                .filter(|value| !value.is_null())
                .cloned();
            let weights = best
                .as_ref()
                .and_then(|candidate| candidate.get("weights"))
                .and_then(Value::as_object)
                .cloned();
            seed_runs.push(json!({
                "configuredSeed": configured_seed,
                "effectiveSeed": effective_seed,
                "candidateBudget": seed_budget,
                "candidateCount": candidate_count,
                "objectiveValue": best.as_ref().and_then(|candidate| objective_metric(candidate, objective)),
                "feasible": best.is_some(),
            }));
            if let (Some(best), Some(weights)) = (best, weights) {
                seed_weights.push(weights.clone());
                if selected
                    .as_ref()
                    .is_none_or(|(current, _, _)| candidate_is_better(&best, current, objective))
                {
                    selected = Some((best, weights, effective_seed));
                }
            }
        }
        let (best, weights, selected_seed) =
            selected.context("no feasible walk-forward candidate")?;
        let seed_stability = seed_weight_stability(&series, &seed_weights);
        if let Some(distance) = seed_stability
            .get("meanPairwiseWeightDistance")
            .and_then(Value::as_f64)
        {
            fold_seed_distances.push(distance);
        }
        let turnover = weight_turnover(&series, &previous_weights, &weights);
        let transaction_cost = turnover * transaction_cost_bps / 10_000.0;
        let mut returns = aligned_returns(
            &series,
            &dates,
            &weights,
            window.test_start,
            window.test_end,
        );
        if let Some(first) = returns.first_mut() {
            *first = (1.0 - transaction_cost) * (1.0 + *first) - 1.0;
        }
        let fold_benchmark = benchmark
            .as_ref()
            .and_then(|value| benchmark_returns(value, &dates, window.test_start, window.test_end));
        if benchmark.is_some() && fold_benchmark.is_none() {
            benchmark_complete = false;
        }
        let portfolio_growth = returns.iter().fold(1.0, |value, item| value * (1.0 + item));
        let benchmark_growth = fold_benchmark
            .as_ref()
            .map(|values| values.iter().fold(1.0, |value, item| value * (1.0 + item)));
        if let Some(benchmark_growth) = benchmark_growth {
            benchmark_fold_wins.push(portfolio_growth > benchmark_growth);
        }
        let mut oos = oos_metrics(&returns, turnover, transaction_cost);
        if let Some(object) = oos.as_object_mut() {
            object.insert(
                "benchmarkReturn".into(),
                benchmark_growth
                    .map(|growth| json!(round(growth - 1.0, 10)))
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "outperformedBenchmark".into(),
                benchmark_growth
                    .map(|growth| json!(portfolio_growth > growth))
                    .unwrap_or(Value::Null),
            );
        }
        for (relative, daily_return) in returns.iter().copied().enumerate() {
            stitched_returns.push(daily_return);
            stitched_dates.push(dates[window.test_start + relative + 1].clone());
        }
        if let Some(values) = &fold_benchmark {
            stitched_benchmark_returns.extend(values.iter().copied());
        }
        total_turnover += turnover;
        total_transaction_cost += transaction_cost;
        let gap_range = (window.gap > 0).then(|| {
            json!({
                "startIndex": window.train_end + 1,
                "endIndex": window.test_start - 1,
            })
        });
        let embargo_range =
            (window.embargo > 0 && window.test_end + 1 < dates.len() - 1).then(|| {
                json!({
                    "startIndex": window.test_end + 1,
                    "endIndex": (window.test_end + window.embargo).min(dates.len() - 2),
                })
            });
        folds.push(json!({
            "index": index,
            "mode": window.mode.as_str(),
            "trainStartIndex": window.train_start,
            "trainEndIndex": window.train_end,
            "testStartIndex": window.test_start,
            "testEndIndex": window.test_end,
            "trainStart": dates[window.train_start],
            "trainEnd": dates[window.train_end + 1],
            "testStart": dates[window.test_start],
            "testEnd": dates[window.test_end + 1],
            "trainCount": window.train_end - window.train_start + 1,
            "testCount": window.test_end - window.test_start + 1,
            "gap": window.gap,
            "embargo": window.embargo,
            "purgedGap": gap_range,
            "embargoRange": embargo_range,
            "weights": weights,
            "selected": best,
            "selectedSeed": selected_seed,
            "seedRuns": seed_runs,
            "seedStability": seed_stability,
            "foldCandidateBudget": fold_budget,
            "trainCandidateCount": fold_candidate_count,
            "oos": oos,
        }));
        previous_weights = weights;
    }
    let oos_returns = folds
        .iter()
        .filter_map(|fold| fold.pointer("/oos/return").and_then(Value::as_f64))
        .collect::<Vec<_>>();
    let worst = folds
        .iter()
        .min_by(|left, right| {
            left.pointer("/oos/return")
                .and_then(Value::as_f64)
                .unwrap_or(f64::INFINITY)
                .total_cmp(
                    &right
                        .pointer("/oos/return")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::INFINITY),
                )
        })
        .cloned()
        .unwrap_or(Value::Null);
    let mut selection_frequency = BTreeMap::<String, usize>::new();
    let mut weight_values = BTreeMap::<String, Vec<f64>>::new();
    for fold in &folds {
        if let Some(weights) = fold.get("weights").and_then(Value::as_object) {
            for (key, weight) in weights {
                let value = weight.as_f64().unwrap_or(0.0);
                if value > 0.0 {
                    *selection_frequency.entry(key.clone()).or_default() += 1;
                }
                weight_values.entry(key.clone()).or_default().push(value);
            }
        }
    }
    let stability = weight_values.into_iter().map(|(key, values)| (key, json!({
        "mean": round(average(&values), 8),
        "standardDeviation": (values.len() > 1).then(|| round(sample_std(&values), 8)),
        "min": values.iter().copied().min_by(f64::total_cmp).map(|value| round(value, 8)),
        "max": values.iter().copied().max_by(f64::total_cmp).map(|value| round(value, 8)),
    }))).collect::<Map<_, _>>();
    let mut warnings = payload
        .get("market_warnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if benchmark.is_none() {
        warnings.push(json!(
            "benchmark win rate and information ratio are unavailable because optimization.benchmark was not supplied"
        ));
    } else if !benchmark_complete {
        warnings.push(json!(
            "benchmark win rate and information ratio are partially unavailable because benchmark dates did not cover every OOS fold"
        ));
    }
    let total_observations = dates.len() - 1;
    let coverage = (stitched_returns.len() as f64 / total_observations as f64).clamp(0.0, 1.0);
    let benchmark_for_metrics = (benchmark_complete
        && stitched_benchmark_returns.len() == stitched_returns.len())
    .then_some(stitched_benchmark_returns.as_slice());
    let stitched_metrics = stitched_oos_metrics(&stitched_returns, benchmark_for_metrics);
    let benchmark_win_rate = (!benchmark_fold_wins.is_empty()).then(|| {
        benchmark_fold_wins.iter().filter(|value| **value).count() as f64
            / benchmark_fold_wins.len() as f64
    });
    let mut portfolio_equity = 1.0_f64;
    let mut benchmark_equity = 1.0_f64;
    let stitched_equity = stitched_returns
        .iter()
        .enumerate()
        .map(|(index, daily_return)| {
            portfolio_equity *= 1.0 + daily_return;
            let benchmark_value = benchmark_for_metrics.map(|returns| {
                benchmark_equity *= 1.0 + returns[index];
                round(benchmark_equity, 10)
            });
            json!({
                "date": stitched_dates[index],
                "equity": round(portfolio_equity, 10),
                "benchmarkEquity": benchmark_value,
            })
        })
        .collect::<Vec<_>>();
    let mean_pairwise_weight_distance = if fold_seed_distances.is_empty() {
        0.0
    } else {
        round(average(&fold_seed_distances), 10)
    };
    let seed_stability = json!({
        "seedCount": seeds.len(),
        "foldCount": folds.len(),
        "meanPairwiseWeightDistance": mean_pairwise_weight_distance,
        "maxPairwiseWeightDistance": fold_seed_distances.iter().copied().max_by(f64::total_cmp).map(|value| round(value, 10)).unwrap_or(0.0),
        "deterministic": true,
    });
    checkpoint(control)?;
    Ok(json!({
        "objective": objective,
        "configuration": {
            "mode": windows[0].mode.as_str(),
            "gap": windows[0].gap,
            "embargo": windows[0].embargo,
            "seeds": seeds,
            "foldCandidateBudgets": fold_budgets,
        },
        "folds": folds,
        "worstValidationWindow": worst,
        "weightStability": stability,
        "seedStability": seed_stability,
        "selectionFrequency": selection_frequency,
        "oosSummary": {
            "foldCount": oos_returns.len(),
            "averageReturn": (!oos_returns.is_empty()).then(|| round(average(&oos_returns), 10)),
            "worstReturn": oos_returns.iter().copied().min_by(f64::total_cmp).map(|value| round(value, 10)),
            "bestReturn": oos_returns.iter().copied().max_by(f64::total_cmp).map(|value| round(value, 10)),
            "coverage": round(coverage, 10),
            "coveredObservationCount": stitched_returns.len(),
            "totalObservationCount": total_observations,
            "cagr": stitched_metrics.get("cagr").cloned().unwrap_or(Value::Null),
            "cagrPercent": stitched_metrics.get("cagrPercent").cloned().unwrap_or(Value::Null),
            "maxDrawdown": stitched_metrics.get("maxDrawdown").cloned().unwrap_or(Value::Null),
            "maxDrawdownPercent": stitched_metrics.get("maxDrawdownPercent").cloned().unwrap_or(Value::Null),
            "sharpe": stitched_metrics.get("sharpe").cloned().unwrap_or(Value::Null),
            "informationRatio": stitched_metrics.get("informationRatio").cloned().unwrap_or(Value::Null),
            "benchmarkWinRate": benchmark_win_rate.map(|value| round(value, 10)),
            "benchmarkWinRatePercent": benchmark_win_rate.map(|value| round(value * 100.0, 6)),
            "turnover": round(total_turnover, 10),
            "transactionCost": round(total_transaction_cost, 10),
        },
        "stitchedOosEquity": stitched_equity,
        "summary": {
            "fold_count": windows.len(),
            "worst_validation_window": worst,
            "oos_coverage": round(coverage, 10),
            "oos_cagr": stitched_metrics.get("cagr").cloned().unwrap_or(Value::Null),
            "oos_max_drawdown": stitched_metrics.get("maxDrawdown").cloned().unwrap_or(Value::Null),
            "oos_sharpe": stitched_metrics.get("sharpe").cloned().unwrap_or(Value::Null),
            "oos_information_ratio": stitched_metrics.get("informationRatio").cloned().unwrap_or(Value::Null),
            "benchmark_win_rate": benchmark_win_rate,
        },
        "warnings": warnings,
    }))
}

pub fn compute(kind: JobKind, payload: &Value) -> Result<Value> {
    compute_with_control(kind, payload, None)
}

pub fn compute_with_control(
    kind: JobKind,
    payload: &Value,
    control: Option<&dyn ComputeControl>,
) -> Result<Value> {
    match kind {
        JobKind::WalkForward => walk_forward(payload, control),
        JobKind::StressTest
        | JobKind::WeightSensitivity
        | JobKind::StartDateSensitivity
        | JobKind::RebalanceSensitivity
        | JobKind::CashFlowSensitivity => scenarios(kind, payload, control),
        _ => bail!("job kind is not a batch job"),
    }
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
                anyhow::bail!("TEST_BATCH_CANCELLED");
            }
            Ok(())
        }
    }

    #[test]
    fn distribution_is_stable_and_uses_true_median() {
        let values = vec![
            json!({"metrics":{"totalReturnPercent": 3.0}}),
            json!({"metrics":{"totalReturnPercent": 1.0}}),
            json!({"metrics":{"totalReturnPercent": 2.0}}),
        ];
        assert_eq!(
            distribution(&values, "totalReturnPercent"),
            json!({"min":1.0,"median":2.0,"max":3.0})
        );
    }

    #[test]
    fn cvar_uses_lower_tail() {
        assert_eq!(cvar(&[-0.2, -0.1, 0.1, 0.2], 0.75), Some(-0.2));
    }

    fn scenario(id: &str, end_price: f64) -> Value {
        json!({
            "id": id,
            "name": id,
            "simulation": {
                "assets": [{
                    "symbol": "AAA", "name": "AAA", "market": "KR", "currency": "KRW",
                    "listDate": "2020-01-01", "weight": 100.0, "lotSize": 1.0
                }],
                "prices": {"KRW:AAA": [
                    {"date": "2024-01-02", "close": 100.0, "localClose": 100.0, "fxRate": 1.0},
                    {"date": "2024-01-03", "close": end_price, "localClose": end_price, "fxRate": 1.0}
                ]},
                "requestedStartDate": "2024-01-02",
                "endDate": "2024-01-03",
                "initialAmount": 1000.0,
                "transactionCostBps": 0.0
            }
        })
    }

    #[test]
    fn stress_scenarios_run_in_parallel_and_identify_worst_path() {
        let payload = json!({"scenarios": [scenario("up", 110.0), scenario("down", 80.0)]});
        let single = ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap()
            .install(|| compute(JobKind::StressTest, &payload).unwrap());
        let parallel = ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap()
            .install(|| compute(JobKind::StressTest, &payload).unwrap());
        assert_eq!(single, parallel);
        assert_eq!(parallel["scenarioCount"], 2);
        assert_eq!(parallel["worstScenario"]["id"], "down");
        assert_eq!(
            parallel["distributions"]["totalReturnPercent"]["min"],
            -20.0
        );
        assert_eq!(parallel["distributions"]["totalReturnPercent"]["max"], 10.0);
    }

    #[test]
    fn cooperative_control_stops_parallel_scenarios_without_partial_result() {
        let payload = json!({"scenarios": [scenario("up", 110.0), scenario("down", 80.0)]});
        let control = StopAfter {
            remaining: AtomicUsize::new(1),
        };
        assert!(
            compute_with_control(JobKind::StressTest, &payload, Some(&control))
                .unwrap_err()
                .to_string()
                .contains("TEST_BATCH_CANCELLED")
        );
    }

    fn walk_forward_series(key: &str, phase: f64) -> Value {
        let mut price = 100.0;
        let points = (0..70)
            .map(|index| {
                price *= 1.0 + 0.0008 + ((index as f64) / 6.0 + phase).sin() * 0.003;
                json!({
                    "date": crate::date::add_days("2024-01-01", index).unwrap(),
                    "value": price,
                })
            })
            .collect::<Vec<_>>();
        json!({"key": key, "label": key, "points": points})
    }

    #[test]
    fn walk_forward_optimizes_train_windows_and_scores_only_oos_data() {
        let payload = json!({
            "optimization": {
                "priceSeries": [walk_forward_series("A", 0.0), walk_forward_series("B", 1.4)],
                "constraints": {"maxAssets": 2},
                "candidateBudget": 24,
                "minimumSamples": 5,
                "seed": 42,
                "transactionCostBps": 100,
                "walkForwardConfig": {
                    "enabled": true,
                    "mode": "holdout",
                    "trainFraction": 0.8,
                    "testFraction": 0.2,
                    "minimumTrainObservations": 10,
                    "minimumTestObservations": 5
                }
            },
            "walkForwardConfig": {
                "trainWindow": 30,
                "testWindow": 10,
                "step": 10,
                "minimumTrainObservations": 20,
                "minimumTestObservations": 5
            },
            "objective": "robust_score"
        });
        let first = compute(JobKind::WalkForward, &payload).unwrap();
        let second = compute(JobKind::WalkForward, &payload).unwrap();
        assert_eq!(first, second);
        let folds = first["folds"].as_array().unwrap();
        assert!(!folds.is_empty());
        assert!(
            folds
                .iter()
                .all(|fold| fold["trainEndIndex"].as_u64().unwrap()
                    < fold["testStartIndex"].as_u64().unwrap())
        );
        assert!(
            folds
                .iter()
                .all(|fold| fold["oos"]["sampleCount"].as_u64().unwrap() > 0)
        );
        assert!(folds[0]["oos"]["transactionCost"].as_f64().unwrap() > 0.0);
        assert!(folds.iter().all(|fold| {
            fold["selected"]["robustScoreDetail"]["outOfSampleScore"].is_number()
                && fold["selected"]["sampleCount"].as_u64().unwrap()
                    < fold["trainCount"].as_u64().unwrap()
        }));
        assert_eq!(
            first["oosSummary"]["foldCount"].as_u64().unwrap() as usize,
            folds.len()
        );
    }

    #[test]
    fn walk_forward_rejects_budget_smaller_than_fold_count() {
        let payload = json!({
            "optimization": {
                "priceSeries": [walk_forward_series("A", 0.0), walk_forward_series("B", 1.4)],
                "constraints": {"maxAssets": 2},
                "candidateBudget": 1,
                "minimumSamples": 5
            },
            "walkForwardConfig": {"trainWindow": 20, "testWindow": 5, "step": 5},
            "objective": "robust_score"
        });
        assert!(
            compute(JobKind::WalkForward, &payload)
                .unwrap_err()
                .to_string()
                .contains("candidateBudget")
        );
    }

    #[test]
    fn anchored_gap_embargo_multiseed_produces_non_overlapping_stitched_oos() {
        let payload = json!({
            "optimization": {
                "priceSeries": [walk_forward_series("A", 0.0), walk_forward_series("B", 1.4)],
                "benchmark": walk_forward_series("BM", 0.7),
                "constraints": {"maxAssets": 2},
                "candidateBudget": 120,
                "minimumSamples": 5,
                "seed": 42,
                "transactionCostBps": 10
            },
            "walkForwardConfig": {
                "mode": "anchored",
                "trainWindow": 20,
                "testWindow": 5,
                "step": 3,
                "gap": 2,
                "embargo": 2,
                "minimumTrainObservations": 20,
                "minimumTestObservations": 5,
                "foldCandidateBudget": 20,
                "seeds": [41, 42]
            },
            "objective": "robust_score"
        });
        let first = compute(JobKind::WalkForward, &payload).unwrap();
        let second = compute(JobKind::WalkForward, &payload).unwrap();
        assert_eq!(first, second);
        let folds = first["folds"].as_array().unwrap();
        assert!(folds.len() >= 2);
        for (index, fold) in folds.iter().enumerate() {
            assert_eq!(fold["trainStartIndex"], 0);
            assert_eq!(fold["mode"], "anchored");
            assert_eq!(fold["seedRuns"].as_array().unwrap().len(), 2);
            assert_eq!(
                fold["seedRuns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|run| run["candidateBudget"].as_u64().unwrap())
                    .sum::<u64>(),
                20
            );
            let train_end = fold["trainEndIndex"].as_u64().unwrap();
            let test_start = fold["testStartIndex"].as_u64().unwrap();
            assert_eq!(train_end + 3, test_start);
            if index > 0 {
                let previous_end = folds[index - 1]["testEndIndex"].as_u64().unwrap();
                assert!(test_start > previous_end + 1);
            }
        }
        let coverage = first["oosSummary"]["coverage"].as_f64().unwrap();
        assert!((0.0..=1.0).contains(&coverage));
        assert_eq!(
            first["stitchedOosEquity"].as_array().unwrap().len() as u64,
            first["oosSummary"]["coveredObservationCount"]
                .as_u64()
                .unwrap()
        );
        for key in [
            "cagr",
            "maxDrawdown",
            "sharpe",
            "informationRatio",
            "benchmarkWinRate",
        ] {
            assert!(first["oosSummary"][key].is_number(), "missing {key}");
        }
        assert_eq!(first["seedStability"]["seedCount"], 2);
    }

    #[test]
    fn first_fold_selection_cannot_see_gap_or_oos_prices() {
        let payload = json!({
            "optimization": {
                "priceSeries": [walk_forward_series("A", 0.0), walk_forward_series("B", 1.4)],
                "constraints": {"maxAssets": 2},
                "candidateBudget": 30,
                "minimumSamples": 5,
                "seed": 77
            },
            "walkForwardConfig": {
                "mode": "rolling",
                "trainWindow": 30,
                "testWindow": 10,
                "step": 10,
                "gap": 2,
                "embargo": 0,
                "minimumTrainObservations": 20,
                "minimumTestObservations": 5
            },
            "objective": "robust_score"
        });
        let baseline = compute(JobKind::WalkForward, &payload).unwrap();
        let first_fold = &baseline["folds"][0];
        let train_end = first_fold["trainEndIndex"].as_u64().unwrap() as usize;
        let test_start = first_fold["testStartIndex"].as_u64().unwrap() as usize;
        assert!(train_end + 1 < test_start);

        let mut mutated = payload.clone();
        let changed_point = &mut mutated["optimization"]["priceSeries"][0]["points"]
            .as_array_mut()
            .unwrap()[test_start + 3];
        let original = changed_point["value"].as_f64().unwrap();
        changed_point["value"] = json!(original * 1.8);
        let changed = compute(JobKind::WalkForward, &mutated).unwrap();
        assert_eq!(
            baseline["folds"][0]["weights"],
            changed["folds"][0]["weights"]
        );
        assert_eq!(
            baseline["folds"][0]["selectedSeed"],
            changed["folds"][0]["selectedSeed"]
        );
        assert_ne!(baseline["folds"][0]["oos"], changed["folds"][0]["oos"]);
        assert!(
            changed["folds"]
                .as_array()
                .unwrap()
                .windows(2)
                .all(|pair| pair[0]["testEndIndex"].as_u64().unwrap()
                    < pair[1]["testStartIndex"].as_u64().unwrap())
        );
        assert!(changed["oosSummary"]["coverage"].as_f64().unwrap() <= 1.0);
    }
}
