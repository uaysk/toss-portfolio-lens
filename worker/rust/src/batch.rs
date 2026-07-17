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
    let config = payload
        .get("walkForwardConfig")
        .or_else(|| optimization.get("walkForwardConfig"));
    let windows = crate::optimization::build_walk_forward_windows(dates.len() - 1, config);
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
    ensure!(
        total_budget >= windows.len(),
        "candidateBudget must be at least the walk-forward fold count ({})",
        windows.len()
    );
    let per_fold = (total_budget / windows.len()).max(1);
    let base_seed = optimization
        .get("seed")
        .and_then(Value::as_u64)
        .unwrap_or(12_345);
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
    let mut folds = Vec::with_capacity(windows.len());
    for (index, window) in windows.iter().enumerate() {
        checkpoint(control)?;
        let train_start = window
            .get("trainStartIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let train_end = window
            .get("trainEndIndex")
            .and_then(Value::as_u64)
            .context("trainEndIndex missing")? as usize;
        let test_start = window
            .get("testStartIndex")
            .and_then(Value::as_u64)
            .context("testStartIndex missing")? as usize;
        let test_end = window
            .get("testEndIndex")
            .and_then(Value::as_u64)
            .context("testEndIndex missing")? as usize;
        ensure!(
            test_end < dates.len() - 1,
            "walk-forward window exceeds price observations"
        );
        let mut training = optimization_object.clone();
        training.insert(
            "priceSeries".into(),
            sliced_price_series(&series, &dates[train_start], &dates[train_end + 1]),
        );
        training.insert(
            "candidateBudget".into(),
            json!(per_fold + usize::from(index < total_budget % windows.len())),
        );
        training.insert("seed".into(), json!(base_seed + index as u64));
        training.remove("walkForwardConfig");
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
        let best = optimized
            .pointer(&format!("/bestByObjective/{objective}"))
            .filter(|value| !value.is_null())
            .context("no feasible walk-forward candidate")?;
        let weights = best
            .get("weights")
            .and_then(Value::as_object)
            .context("selected candidate weights missing")?;
        let turnover = weight_turnover(&series, &previous_weights, weights);
        let transaction_cost = turnover * transaction_cost_bps / 10_000.0;
        let mut returns = aligned_returns(&series, &dates, weights, test_start, test_end);
        if let Some(first) = returns.first_mut() {
            *first = (1.0 - transaction_cost) * (1.0 + *first) - 1.0;
        }
        let mut fold = window.clone();
        if let Some(object) = fold.as_object_mut() {
            object.insert("index".into(), json!(index));
            object.insert("weights".into(), Value::Object(weights.clone()));
            object.insert("selected".into(), best.clone());
            object.insert(
                "oos".into(),
                oos_metrics(&returns, turnover, transaction_cost),
            );
            object.insert(
                "trainCandidateCount".into(),
                optimized
                    .get("candidateCount")
                    .cloned()
                    .unwrap_or_else(|| json!(0)),
            );
        }
        previous_weights = weights.clone();
        folds.push(fold);
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
    let warnings = payload
        .get("market_warnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    checkpoint(control)?;
    Ok(json!({
        "objective": objective,
        "folds": folds,
        "worstValidationWindow": worst,
        "weightStability": stability,
        "selectionFrequency": selection_frequency,
        "oosSummary": {
            "foldCount": oos_returns.len(),
            "averageReturn": (!oos_returns.is_empty()).then(|| round(average(&oos_returns), 10)),
            "worstReturn": oos_returns.iter().copied().min_by(f64::total_cmp).map(|value| round(value, 10)),
            "bestReturn": oos_returns.iter().copied().max_by(f64::total_cmp).map(|value| round(value, 10)),
        },
        "summary": {"fold_count": windows.len(), "worst_validation_window": worst},
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
                "transactionCostBps": 100
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
}
