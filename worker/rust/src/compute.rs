use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

use crate::backtest;
use crate::contracts::{JobKind, OutputArtifact, WorkerInput, WorkerOutput};
use crate::control::{ComputeControl, checkpoint};
use crate::date::civil_from_days;
use crate::model::BacktestSimulationInput;
use crate::stats::round;

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
        array_artifact(
            "dividends",
            result
                .get("dividends")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        array_artifact(
            "target-weight-schedule",
            result
                .get("targetWeightSchedule")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        array_artifact(
            "data-quality",
            result
                .get("dataQuality")
                .cloned()
                .unwrap_or_else(|| json!({})),
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
    let ledger_validated_candidates = output
        .get("ledgerValidatedCandidates")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let frontier = output
        .get("paretoFrontier")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let regime_policy_artifact = output.get("regimePolicyArtifact").cloned();
    let mut result = output.clone();
    if let Some(object) = result.as_object_mut() {
        object.remove("regimePolicyArtifact");
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
        "screening_candidate_count": output.get("screeningCandidateCount").cloned().unwrap_or_else(|| json!(0)),
        "baseline_candidate_count": output.get("baselineCandidateCount").cloned().unwrap_or_else(|| json!(0)),
        "pareto_count": frontier.as_array().map(Vec::len).unwrap_or(0),
        "algorithm": output.get("algorithm").cloned().unwrap_or_else(|| json!("random_search")),
        "ledger_validation_requested_count": output.pointer("/ledgerValidation/selectedCount").cloned().unwrap_or_else(|| json!(0)),
        "ledger_validated_count": output.pointer("/ledgerValidation/completedCount").cloned().unwrap_or_else(|| json!(0)),
        "ledger_validation_failed_count": output.pointer("/ledgerValidation/failedCount").cloned().unwrap_or_else(|| json!(0)),
        "stages": {
            "screening": {
                "candidateCount": output.get("screeningCandidateCount").cloned().unwrap_or_else(|| json!(0)),
                "paretoCount": frontier.as_array().map(Vec::len).unwrap_or(0),
            },
            "ledgerValidation": output.get("ledgerValidation").cloned().unwrap_or_else(|| json!({"status": "not_requested"})),
            "regimePolicySearch": output.get("regimePolicySearch").cloned().unwrap_or_else(|| json!({"enabled": false, "status": "not_requested"})),
        },
    });
    let artifacts = if include_artifacts {
        let mut artifacts = vec![
            array_artifact("candidates", candidates.clone()),
            array_artifact("screening-candidates", candidates),
            array_artifact("ledger-validated-candidates", ledger_validated_candidates),
            array_artifact("worker-pareto-frontier", frontier),
        ];
        if let Some(regime_policy_artifact) = regime_policy_artifact {
            artifacts.push(array_artifact("regime-policy", regime_policy_artifact));
        }
        artifacts
    } else {
        vec![]
    };
    WorkerOutput::completed(input, summary, result, warnings, artifacts)
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

fn finite_at(value: &Value, pointers: &[&str]) -> Option<f64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_f64))
        .filter(|value| value.is_finite())
}

fn append_value_warnings(warnings: &mut Vec<String>, value: &Value) {
    for warning in value
        .get("warnings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !warnings.iter().any(|existing| existing == warning) {
            warnings.push(warning.to_owned());
        }
    }
}

fn stitched_oos_equity(walk_forward: &Value) -> Vec<Value> {
    if let Some(stitched) = walk_forward
        .get("stitchedOosEquity")
        .or_else(|| walk_forward.get("stitched_oos_equity"))
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
    {
        return stitched.clone();
    }
    let mut equity = 1.0;
    walk_forward
        .get("folds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, fold)| {
            let portfolio_return = finite_at(fold, &["/oos/return"])?;
            if portfolio_return <= -1.0 {
                return None;
            }
            equity *= 1.0 + portfolio_return;
            let date = fold
                .get("testEnd")
                .or_else(|| fold.get("test_end"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("fold-{}", index + 1));
            Some(json!({"fold": index, "date": date, "equity": equity}))
        })
        .collect()
}

fn oos_coverage(walk_forward: &Value) -> Option<f64> {
    if let Some(coverage) = finite_at(
        walk_forward,
        &["/oosSummary/coverage", "/oos_summary/coverage"],
    ) {
        return Some(coverage.clamp(0.0, 1.0));
    }
    let folds = walk_forward.get("folds")?.as_array()?;
    if folds.is_empty() {
        return None;
    }
    let tested = folds
        .iter()
        .filter_map(|fold| finite_at(fold, &["/oos/sampleCount"]))
        .sum::<f64>();
    let denominator = folds
        .iter()
        .map(|fold| {
            finite_at(fold, &["/trainCount", "/train_count"]).unwrap_or(0.0)
                + finite_at(fold, &["/oos/sampleCount"]).unwrap_or(0.0)
        })
        .sum::<f64>();
    (denominator > 0.0).then(|| (tested / denominator).clamp(0.0, 1.0))
}

fn calibration_score(monte_carlo: &Value) -> Option<f64> {
    if let Some(score) = finite_at(
        monte_carlo,
        &[
            "/calibration/score",
            "/calibration/intervalCoverageScore",
            "/calibration/coverageScore",
        ],
    ) {
        return Some(score.clamp(0.0, 1.0));
    }
    let coverage = finite_at(monte_carlo, &["/calibration/coveragePercent"])?;
    let lower = finite_at(monte_carlo, &["/calibration/lowerQuantile"])?;
    let upper = finite_at(monte_carlo, &["/calibration/upperQuantile"])?;
    let nominal = (upper - lower).clamp(0.0, 1.0) * 100.0;
    let coverage_alignment = (1.0 - (coverage - nominal).abs() / 100.0).clamp(0.0, 1.0);
    let bias = finite_at(monte_carlo, &["/calibration/biasPercent"]).unwrap_or(0.0);
    let bias_score = (1.0 - bias.abs() / 100.0).clamp(0.0, 1.0);
    Some(0.7 * coverage_alignment + 0.3 * bias_score)
}

fn terminal_balance_quantiles(monte_carlo: &Value) -> Vec<Value> {
    monte_carlo
        .pointer("/distributions/terminalBalance/percentiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(json!({
                "quantile": finite_at(item, &["/quantile"] )?,
                "balance": finite_at(item, &["/value"] )?,
            }))
        })
        .collect()
}

fn worst_stress_scenarios(stress: &Value) -> Vec<Value> {
    let all_scenarios = stress
        .get("scenarios")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut scenarios = all_scenarios
        .iter()
        .filter(|scenario| {
            !scenario
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("outlook-sensitivity-"))
        })
        .cloned()
        .collect::<Vec<_>>();
    if scenarios.is_empty() {
        scenarios = all_scenarios;
    }
    scenarios.sort_by(|left, right| {
        finite_at(left, &["/metrics/totalReturnPercent"])
            .unwrap_or(f64::INFINITY)
            .total_cmp(&finite_at(right, &["/metrics/totalReturnPercent"]).unwrap_or(f64::INFINITY))
    });
    scenarios.truncate(5);
    scenarios
}

fn outlook_sensitivity(stress: &Value) -> Value {
    let scenarios = stress
        .get("scenarios")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|scenario| {
            scenario
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("outlook-sensitivity-"))
        })
        .cloned()
        .collect::<Vec<_>>();
    let baseline_metrics = scenarios
        .first()
        .and_then(|scenario| scenario.get("metrics"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let metric_names = [
        "totalReturnPercent",
        "cagrPercent",
        "annualizedVolatilityPercent",
        "maxDrawdownPercent",
        "sharpeRatio",
        "totalTransactionCosts",
        "finalBalance",
    ];
    let enriched = scenarios
        .into_iter()
        .map(|mut scenario| {
            let deltas = metric_names
                .iter()
                .filter_map(|name| {
                    let value = scenario.pointer(&format!("/metrics/{name}"))?.as_f64()?;
                    let baseline = baseline_metrics.get(*name)?.as_f64()?;
                    Some(((*name).to_owned(), json!(round(value - baseline, 6))))
                })
                .collect::<Map<_, _>>();
            if let Some(object) = scenario.as_object_mut() {
                object.insert("metricDeltas".to_owned(), Value::Object(deltas));
            }
            scenario
        })
        .collect::<Vec<_>>();
    json!({
        "baselineScenarioId": enriched.first().and_then(|scenario| scenario.get("id")).cloned(),
        "scenarioCount": enriched.len(),
        "scenarios": enriched,
    })
}

fn outlook_metric(scenario: &Value, name: &str) -> Option<f64> {
    scenario
        .pointer(&format!("/metrics/{name}"))
        .and_then(Value::as_f64)
        .or_else(|| scenario.get(name).and_then(Value::as_f64))
}

fn outlook_distribution(scenarios: &[Value], name: &str) -> Value {
    let mut values = scenarios
        .iter()
        .filter_map(|scenario| outlook_metric(scenario, name))
        .collect::<Vec<_>>();
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return Value::Null;
    }
    let middle = values.len() / 2;
    let median = if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    };
    json!({
        "min": round(values[0], 6),
        "median": round(median, 6),
        "max": round(*values.last().unwrap_or(&values[0]), 6),
    })
}

fn outlook_stress_summary(stress: &Value, worst_scenarios: &[Value]) -> Value {
    let scenarios = stress
        .get("scenarios")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|scenario| {
            !scenario
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("outlook-sensitivity-"))
        })
        .cloned()
        .collect::<Vec<_>>();
    let metrics = [
        "totalReturnPercent",
        "cagrPercent",
        "annualizedVolatilityPercent",
        "maxDrawdownPercent",
        "sharpeRatio",
        "cvar95Percent",
        "totalTransactionCosts",
    ];
    let distributions = metrics
        .iter()
        .map(|name| ((*name).to_owned(), outlook_distribution(&scenarios, name)))
        .collect::<Map<_, _>>();
    json!({
        "scenarioCount": scenarios.len(),
        "worstScenarios": worst_scenarios,
        "worstScenario": worst_scenarios.first().cloned(),
        "distributions": distributions,
    })
}

fn confidence_weight(
    weights: Option<&Map<String, Value>>,
    camel: &str,
    snake: &str,
    fallback: f64,
) -> f64 {
    weights
        .and_then(|weights| weights.get(camel).or_else(|| weights.get(snake)))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .clamp(0.0, 1.0)
}

fn truncated_outlook_optimization(optimization: Option<&Value>) -> Value {
    let Some(optimization) = optimization else {
        return Value::Null;
    };
    let mut result = optimization.clone();
    if let Some(object) = result.as_object_mut() {
        object.remove("regimePolicyArtifact");
        if let Some(candidates) = object.get_mut("candidates").and_then(Value::as_array_mut) {
            candidates.truncate(20);
        }
        if let Some(frontier) = object
            .get_mut("paretoFrontier")
            .and_then(Value::as_array_mut)
        {
            frontier.truncate(100);
        }
        if let Some(validated) = object
            .get_mut("ledgerValidatedCandidates")
            .and_then(Value::as_array_mut)
        {
            validated.truncate(128);
        }
    }
    result
}

fn json_price_returns(series: &Value) -> Vec<(String, f64)> {
    let mut prices = BTreeMap::<String, f64>::new();
    for point in series
        .get("points")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(date) = point.get("date").and_then(Value::as_str) else {
            continue;
        };
        let Some(price) = point
            .get("value")
            .or_else(|| point.get("close"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
        else {
            continue;
        };
        prices.insert(date.to_owned(), price);
    }
    let mut previous = None::<f64>;
    prices
        .into_iter()
        .filter_map(|(date, price)| {
            let value = previous
                .map(|previous| price / previous - 1.0)
                .filter(|value| value.is_finite() && *value > -1.0);
            previous = Some(price);
            value.map(|value| (date, value))
        })
        .collect()
}

fn outlook_regime_source(payload: &Value) -> (String, Vec<(String, f64)>) {
    let optimization = payload
        .pointer("/walk_forward/optimization")
        .or_else(|| payload.pointer("/walk_forward/walk_forward/optimization"));
    let Some(optimization) = optimization else {
        return ("unavailable".to_owned(), Vec::new());
    };
    if let Some(benchmark) = optimization
        .get("benchmarkPriceSeries")
        .or_else(|| optimization.get("benchmark_price_series"))
        .filter(|value| value.is_object())
    {
        return ("benchmark".to_owned(), json_price_returns(benchmark));
    }
    let series = optimization
        .get("priceSeries")
        .or_else(|| optimization.get("price_series"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if series.is_empty() {
        return ("unavailable".to_owned(), Vec::new());
    }
    let configured_weights = optimization
        .pointer("/constraints/currentWeights")
        .or_else(|| optimization.pointer("/constraints/current_weights"))
        .and_then(Value::as_object);
    let parsed = series
        .iter()
        .map(|item| {
            let key = item
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let weight = configured_weights
                .and_then(|weights| weights.get(&key))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0)
                .unwrap_or(0.0);
            (
                key,
                weight,
                json_price_returns(item)
                    .into_iter()
                    .collect::<BTreeMap<_, _>>(),
            )
        })
        .collect::<Vec<_>>();
    let configured_total = parsed.iter().map(|(_, weight, _)| *weight).sum::<f64>();
    let equal_weight = 1.0 / parsed.len() as f64;
    let dates = parsed[0].2.keys().cloned().collect::<Vec<_>>();
    let returns = dates
        .into_iter()
        .filter_map(|date| {
            let values = parsed
                .iter()
                .map(|(_, weight, points)| {
                    let value = points.get(&date).copied()?;
                    let normalized = if configured_total > 0.0 {
                        *weight / configured_total
                    } else {
                        equal_weight
                    };
                    Some(value * normalized)
                })
                .collect::<Option<Vec<_>>>()?;
            Some((date, values.into_iter().sum::<f64>()))
        })
        .collect();
    ("portfolio".to_owned(), returns)
}

fn outlook_market_regimes(payload: &Value) -> Value {
    let config = payload.get("market_regime").and_then(Value::as_object);
    let enabled = config
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return json!({"enabled": false, "status": "not_requested", "warnings": []});
    }
    let lookback = config
        .and_then(|value| value.get("lookback"))
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(5, 252) as usize;
    let (source, returns) = outlook_regime_source(payload);
    let mut observations = Vec::new();
    let mut counts = BTreeMap::<String, usize>::new();
    let mut transitions = BTreeMap::<String, usize>::new();
    let mut previous_state = None::<String>;
    for index in lookback..returns.len() {
        let trailing = &returns[index - lookback..index];
        let mean = trailing.iter().map(|(_, value)| *value).sum::<f64>() / lookback as f64;
        let variance = if lookback > 1 {
            trailing
                .iter()
                .map(|(_, value)| (*value - mean).powi(2))
                .sum::<f64>()
                / (lookback - 1) as f64
        } else {
            0.0
        };
        let volatility = variance.max(0.0).sqrt() * 252.0_f64.sqrt();
        let trend = trailing
            .iter()
            .fold(1.0, |growth, (_, value)| growth * (1.0 + *value))
            - 1.0;
        let state = if trend < -0.02 || volatility > 0.30 {
            "risk_off"
        } else if trend > 0.02 && volatility < 0.20 {
            "risk_on"
        } else {
            "neutral"
        };
        *counts.entry(state.to_owned()).or_default() += 1;
        if let Some(previous) = &previous_state
            && previous != state
        {
            *transitions
                .entry(format!("{previous}->{state}"))
                .or_default() += 1;
        }
        previous_state = Some(state.to_owned());
        observations.push(json!({
            "date": returns[index].0,
            "state": state,
            "basedOnThrough": trailing.last().map(|(date, _)| date),
            "trailingReturnPercent": round(trend * 100.0, 6),
            "annualizedVolatilityPercent": round(volatility * 100.0, 6),
        }));
    }
    let warnings = if observations.is_empty() {
        vec![format!(
            "시장 국면 분류에는 과거 수익률이 최소 {}개 필요하지만 {}개만 이용할 수 있습니다.",
            lookback + 1,
            returns.len()
        )]
    } else {
        Vec::new()
    };
    json!({
        "enabled": true,
        "status": if observations.is_empty() { "insufficient_data" } else { "available" },
        "source": source,
        "method": "past_only_fixed_threshold",
        "lookback": lookback,
        "thresholds": {"riskOnTrend": 0.02, "riskOnMaximumVolatility": 0.20, "riskOffTrend": -0.02, "riskOffMinimumVolatility": 0.30},
        "leakageGuard": "각 날짜의 상태는 해당 날짜 직전까지의 trailing return만 사용합니다.",
        "returnObservationCount": returns.len(),
        "observationCount": observations.len(),
        "coverage": if returns.is_empty() { 0.0 } else { observations.len() as f64 / returns.len() as f64 },
        "latest": observations.last().cloned(),
        "stateCounts": counts,
        "transitions": transitions,
        "observations": observations,
        "warnings": warnings,
    })
}

fn truncated_market_regimes(regimes: &Value, externalized: bool) -> Value {
    let mut result = regimes.clone();
    if let Some(object) = result.as_object_mut() {
        object.remove("observations");
        object.insert("observationsExternalized".to_owned(), json!(externalized));
    }
    result
}

fn compute_outlook(
    input: &WorkerInput,
    include_artifacts: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<WorkerOutput> {
    checkpoint(control)?;
    let optimization_request = input.payload.get("optimization").filter(|value| {
        !value.is_null() && value.get("enabled").and_then(Value::as_bool) != Some(false)
    });
    let optimization = optimization_request
        .map(|request| {
            let request = request.get("optimization").unwrap_or(request);
            crate::optimization::optimize_with_control(request, control)
        })
        .transpose()?;
    checkpoint(control)?;

    let walk_forward_request = input
        .payload
        .get("walk_forward")
        .context("outlook payload.walk_forward is required")?;
    let walk_forward_request = walk_forward_request
        .get("walk_forward")
        .unwrap_or(walk_forward_request);
    let walk_forward =
        crate::batch::compute_with_control(JobKind::WalkForward, walk_forward_request, control)?;
    checkpoint(control)?;

    let monte_carlo_request = input
        .payload
        .get("monte_carlo")
        .context("outlook payload.monte_carlo is required")?;
    let monte_carlo_request = monte_carlo_request
        .get("monte_carlo")
        .unwrap_or(monte_carlo_request);
    let monte_carlo = crate::monte_carlo::simulate_with_control(monte_carlo_request, control)?;
    checkpoint(control)?;

    let stress_request = input
        .payload
        .get("stress")
        .context("outlook payload.stress is required")?;
    let stress_request = stress_request.get("stress").unwrap_or(stress_request);
    let stress = crate::batch::compute_with_control(JobKind::StressTest, stress_request, control)?;
    checkpoint(control)?;
    let market_regimes = outlook_market_regimes(&input.payload);
    checkpoint(control)?;

    let mut warnings = Vec::new();
    for warning in input
        .payload
        .get("market_warnings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !warnings.iter().any(|existing| existing == warning) {
            warnings.push(warning.to_owned());
        }
    }
    if let Some(optimization) = &optimization {
        append_value_warnings(&mut warnings, optimization);
    }
    append_value_warnings(&mut warnings, &walk_forward);
    append_value_warnings(&mut warnings, &monte_carlo);
    append_value_warnings(&mut warnings, &stress);
    append_value_warnings(&mut warnings, &market_regimes);

    let stitched_equity = stitched_oos_equity(&walk_forward);
    let coverage = oos_coverage(&walk_forward);
    let calibration_score = calibration_score(&monte_carlo);
    let percentile_paths = monte_carlo
        .get("percentilePaths")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut calibration = monte_carlo
        .get("calibration")
        .cloned()
        .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()));
    if let (Some(calibration), Some(score)) = (calibration.as_mut(), calibration_score)
        && let Some(object) = calibration.as_object_mut()
    {
        object.insert("score".to_owned(), json!(score));
    }
    let worst_scenarios = worst_stress_scenarios(&stress);
    let sensitivity = outlook_sensitivity(&stress);
    let data_quality_score = (1.0 - warnings.len() as f64 * 0.08).clamp(0.0, 1.0);
    if calibration_score.is_none() {
        let warning =
            "Monte Carlo calibration 결과가 없어 신뢰도 계산에서 해당 구성요소를 제외했습니다.";
        if !warnings.iter().any(|existing| existing == warning) {
            warnings.push(warning.to_owned());
        }
    }
    if stitched_equity.is_empty() {
        let warning = "유효한 fold별 OOS 수익률이 없어 stitched OOS equity를 만들지 못했습니다.";
        if !warnings.iter().any(|existing| existing == warning) {
            warnings.push(warning.to_owned());
        }
    }

    let confidence_weights = input
        .payload
        .get("confidence_weights")
        .and_then(Value::as_object);
    let oos_weight = confidence_weight(confidence_weights, "oos", "oos", 0.45);
    let calibration_weight = confidence_weight(
        confidence_weights,
        "monteCarloCalibration",
        "monte_carlo_calibration",
        0.35,
    );
    let data_quality_weight =
        confidence_weight(confidence_weights, "dataQuality", "data_quality", 0.20);
    let components = [
        ("oos", coverage, oos_weight),
        (
            "monte_carlo_calibration",
            calibration_score,
            calibration_weight,
        ),
        (
            "data_quality",
            Some(data_quality_score),
            data_quality_weight,
        ),
    ];
    let available_weight = components
        .iter()
        .filter_map(|(_, raw, weight)| raw.map(|_| *weight))
        .sum::<f64>();
    let confidence_score = if available_weight > 0.0 {
        components
            .iter()
            .filter_map(|(_, raw, weight)| raw.map(|raw| raw * weight))
            .sum::<f64>()
            / available_weight
    } else {
        0.0
    };
    let confidence_components = components
        .into_iter()
        .map(|(name, raw, weight)| {
            json!({"name": name, "raw": raw, "weight": weight, "available": raw.is_some()})
        })
        .collect::<Vec<_>>();
    let confidence = json!({
        "score": confidence_score,
        "label": if confidence_score >= 0.75 { "high" } else if confidence_score >= 0.5 { "medium" } else { "low" },
        "availableWeight": available_weight,
        "components": confidence_components,
    });
    let oos = json!({
        "foldCount": walk_forward.get("folds").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "coverage": coverage,
        "cagr": finite_at(&walk_forward, &["/oosSummary/cagr", "/oos_summary/cagr"]),
        "maxDrawdown": finite_at(&walk_forward, &["/oosSummary/maxDrawdown", "/oos_summary/max_drawdown"]),
        "sharpe": finite_at(&walk_forward, &["/oosSummary/sharpe", "/oos_summary/sharpe"]),
        "informationRatio": finite_at(&walk_forward, &["/oosSummary/informationRatio", "/oos_summary/information_ratio"]),
        "benchmarkWinRate": finite_at(&walk_forward, &["/oosSummary/benchmarkWinRate", "/oos_summary/benchmark_win_rate"]),
        "seedStability": walk_forward.get("seedStability").or_else(|| walk_forward.get("seed_stability")).cloned(),
        "stitchedEquity": stitched_equity,
    });
    let future = json!({
        "terminalBalanceQuantiles": terminal_balance_quantiles(&monte_carlo),
        "terminalLossProbabilityPercent": finite_at(&monte_carlo, &["/probabilities/terminalLossProbabilityPercent"]),
        "goalProbabilityPercent": finite_at(&monte_carlo, &["/probabilities/terminalGoalProbabilityPercent"]),
        "depletionProbabilityPercent": finite_at(&monte_carlo, &["/probabilities/everDepletedProbabilityPercent"]),
        "percentilePaths": [],
        "percentilePathsExternalized": percentile_paths.as_array().is_some_and(|paths| !paths.is_empty()),
    });
    let stress_summary = outlook_stress_summary(&stress, &worst_scenarios);
    let result = json!({
        "future": future,
        "oos": oos,
        "optimization": truncated_outlook_optimization(optimization.as_ref()),
        "stress": stress_summary,
        "sensitivity": sensitivity.clone(),
        "marketRegime": truncated_market_regimes(&market_regimes, include_artifacts),
        "calibration": calibration,
        "confidence": confidence,
        "dataQuality": {
            "status": if warnings.is_empty() { "available" } else { "partial" },
            "warnings": warnings,
            "coverage": {"oos": coverage, "monteCarloCalibration": calibration_score},
        },
        "warnings": warnings,
        "limitation": "역사적 데이터에 기반한 분석·시뮬레이션이며 미래 성과를 보장하지 않습니다.",
    });
    let summary = json!({
        "confidence": confidence,
        "probabilities": {
            "loss": future.get("terminalLossProbabilityPercent").cloned(),
            "goal": future.get("goalProbabilityPercent").cloned(),
            "depletion": future.get("depletionProbabilityPercent").cloned(),
        },
        "oos": oos,
        "worst_scenario": stress_summary.get("worstScenario").cloned(),
        "stages": {
            "optimization": optimization.as_ref().map(|value| value.get("candidateCount").cloned().unwrap_or_else(|| json!(0))),
            "walk_forward": walk_forward.get("folds").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "monte_carlo": monte_carlo.get("pathCount").cloned().unwrap_or_else(|| json!(0)),
            "stress": stress_summary.get("scenarioCount").and_then(Value::as_u64).unwrap_or(0),
            "sensitivity": sensitivity.get("scenarioCount").and_then(Value::as_u64).unwrap_or(0),
            "market_regime": market_regimes.get("observationCount").and_then(Value::as_u64).unwrap_or(0),
        },
        "market_regime": truncated_market_regimes(&market_regimes, include_artifacts),
    });

    let artifacts = if include_artifacts {
        let mut artifacts = vec![
            array_artifact("outlook-summary", result.clone()),
            array_artifact("outlook-oos-equity", stitched_equity.into()),
            array_artifact("outlook-quantile-paths", percentile_paths),
            OutputArtifact {
                artifact_type: "outlook-calibration".to_owned(),
                content: calibration.clone().unwrap_or(Value::Null),
                row_count: Some(usize::from(calibration.is_some())),
            },
            array_artifact("outlook-worst-scenarios", worst_scenarios.into()),
            array_artifact("outlook-sensitivity", sensitivity.clone()),
            array_artifact("outlook-market-regimes", market_regimes.clone()),
            array_artifact("walk-forward", walk_forward.clone()),
            array_artifact(
                "monte-carlo-distribution",
                monte_carlo
                    .get("distributions")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            array_artifact("scenario-comparison", stress.clone()),
        ];
        if let Some(optimization) = &optimization {
            artifacts.push(array_artifact(
                "screening-candidates",
                optimization
                    .get("candidates")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            ));
            artifacts.push(array_artifact(
                "ledger-validated-candidates",
                optimization
                    .get("ledgerValidatedCandidates")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            ));
            if let Some(regime_policies) = optimization.get("regimePolicyArtifact") {
                artifacts.push(array_artifact("regime-policy", regime_policies.clone()));
            }
        }
        artifacts
    } else {
        Vec::new()
    };
    checkpoint(control)?;
    WorkerOutput::completed(input, summary, result, warnings, artifacts)
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
        JobKind::Outlook => compute_outlook(input, include_artifacts, control),
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
    use crate::{ENGINE_VERSION, WORKER_SCHEMA_VERSION};

    fn return_series(key: &str, phase: f64, count: i64) -> Value {
        let mut value = 100.0;
        let points = (0..count)
            .map(|index| {
                value *= 1.0 + 0.001 + (index as f64 / 4.0 + phase).sin() * 0.003;
                json!({
                    "date": crate::date::add_days("2025-01-01", index).unwrap(),
                    "value": value,
                })
            })
            .collect::<Vec<_>>();
        json!({"key": key, "label": key, "points": points})
    }

    fn stress_scenario(id: &str, terminal: f64) -> Value {
        json!({
            "id": id,
            "name": id,
            "simulation": {
                "assets": [{
                    "symbol": "TEST", "name": "TEST", "market": "KR", "currency": "KRW",
                    "listDate": "2020-01-01", "weight": 100.0, "lotSize": 1.0
                }],
                "prices": {"KRW:TEST": [
                    {"date": "2025-01-01", "close": 100.0},
                    {"date": "2025-01-02", "close": terminal}
                ]},
                "requestedStartDate": "2025-01-01",
                "endDate": "2025-01-02",
                "initialAmount": 1000.0
            }
        })
    }

    #[test]
    fn timestamp_is_rfc3339_utc() {
        let value = iso_now();
        assert_eq!(value.len(), 24);
        assert!(value.ends_with('Z'));
        assert_eq!(&value[4..5], "-");
    }

    #[test]
    fn optimization_exposes_screening_and_ledger_stage_artifacts() {
        let input = WorkerInput {
            schema_version: WORKER_SCHEMA_VERSION.to_owned(),
            engine_version: ENGINE_VERSION.to_owned(),
            run_id: "optimization-artifacts".to_owned(),
            job_kind: JobKind::Optimization,
            data_revision: "test-revision".to_owned(),
            request_hash: "0".repeat(64),
            payload: json!({
                "optimization": {
                    "priceSeries": [return_series("A", 0.0, 40), return_series("B", 1.0, 40)],
                    "candidateBudget": 8,
                    "minimumSamples": 10,
                    "seed": 42,
                }
            }),
        };
        let output = compute(&input).unwrap();
        let artifact_types = output
            .artifacts
            .as_ref()
            .unwrap()
            .iter()
            .map(|artifact| artifact.artifact_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            artifact_types,
            vec![
                "candidates",
                "screening-candidates",
                "ledger-validated-candidates",
                "worker-pareto-frontier",
            ]
        );
        let summary = output.summary.unwrap();
        assert!(summary["stages"]["screening"]["candidateCount"].is_number());
        assert_eq!(
            summary["stages"]["ledgerValidation"]["status"],
            "not_requested"
        );
    }

    #[test]
    fn optimization_externalizes_regime_policy_decision_traces() {
        let input = WorkerInput {
            schema_version: WORKER_SCHEMA_VERSION.to_owned(),
            engine_version: ENGINE_VERSION.to_owned(),
            run_id: "optimization-regime-policy".to_owned(),
            job_kind: JobKind::Optimization,
            data_revision: "test-revision".to_owned(),
            request_hash: "2".repeat(64),
            payload: json!({
                "optimization": {
                    "priceSeries": [return_series("A", 0.0, 40), return_series("B", 1.0, 40)],
                    "candidateBudget": 8,
                    "minimumSamples": 5,
                    "seed": 42,
                    "regimePolicySearch": {
                        "enabled": true,
                        "method": "dynamic_programming",
                        "states": 3,
                        "lookback": 5,
                        "rebalanceEvery": 5,
                        "trainFraction": 0.5,
                        "minimumTrainingDecisions": 3,
                        "maxDepth": 4
                    }
                }
            }),
        };
        let output = compute(&input).unwrap();
        assert!(
            output
                .artifacts
                .as_ref()
                .unwrap()
                .iter()
                .any(|artifact| artifact.artifact_type == "regime-policy")
        );
        let result = output.result.as_ref().unwrap();
        assert!(result.get("regimePolicyArtifact").is_none());
        assert_eq!(result["regimePolicySearch"]["status"], "screening_only");
    }

    #[test]
    fn outlook_runs_all_stages_and_externalizes_long_paths() {
        let assets = [return_series("A", 0.0, 60), return_series("B", 1.0, 60)];
        let optimization = json!({
            "priceSeries": assets,
            "constraints": {"maxAssets": 2},
            "candidateBudget": 12,
            "minimumSamples": 5,
            "seed": 42,
        });
        let input = WorkerInput {
            schema_version: WORKER_SCHEMA_VERSION.to_owned(),
            engine_version: ENGINE_VERSION.to_owned(),
            run_id: "outlook-composite".to_owned(),
            job_kind: JobKind::Outlook,
            data_revision: "test-revision".to_owned(),
            request_hash: "1".repeat(64),
            payload: json!({
                "optimization": optimization,
                "walk_forward": {
                    "optimization": {
                        "priceSeries": assets,
                        "constraints": {"maxAssets": 2},
                        "candidateBudget": 24,
                        "minimumSamples": 5,
                        "seed": 42
                    },
                    "objective": "robust_score",
                    "walkForwardConfig": {
                        "trainWindow": 30,
                        "testWindow": 10,
                        "step": 10,
                        "minimumTrainObservations": 20,
                        "minimumTestObservations": 5
                    }
                },
                "monte_carlo": {
                    "priceSeries": assets,
                    "weights": {"A": 0.5, "B": 0.5},
                    "initialAmount": 1000.0,
                    "horizonDays": 5,
                    "pathCount": 100,
                    "blockLength": 5,
                    "seed": 42,
                    "quantiles": [0.1, 0.5, 0.9],
                    "samplePathCount": 2,
                    "calibrationOrigins": 0
                },
                "stress": {
                    "scenarios": [
                        stress_scenario("up", 110.0),
                        stress_scenario("down", 80.0),
                        stress_scenario("outlook-sensitivity-1", 100.0),
                        stress_scenario("outlook-sensitivity-2", 90.0)
                    ]
                },
                "confidence_weights": {
                    "oos": 0.45,
                    "monte_carlo_calibration": 0.35,
                    "data_quality": 0.2
                },
                "market_warnings": []
            }),
        };
        let output = compute(&input).unwrap();
        let result = output.result.as_ref().unwrap();
        assert_eq!(result["future"]["percentilePathsExternalized"], true);
        assert!(
            result["future"]["percentilePaths"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            !result["oos"]["stitchedEquity"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(result["stress"]["worstScenario"]["id"], "down");
        assert_eq!(result["sensitivity"]["scenarioCount"], 2);
        assert_eq!(result["marketRegime"]["status"], "available");
        assert_eq!(result["marketRegime"]["source"], "portfolio");
        assert_eq!(result["marketRegime"]["observationsExternalized"], true);
        assert_eq!(
            result["sensitivity"]["scenarios"][0]["id"],
            "outlook-sensitivity-1"
        );
        assert_eq!(
            result["sensitivity"]["scenarios"][1]["metricDeltas"]["totalReturnPercent"],
            -10.0
        );
        assert!(result["confidence"]["score"].is_number());
        let artifact_types = output
            .artifacts
            .as_ref()
            .unwrap()
            .iter()
            .map(|artifact| artifact.artifact_type.as_str())
            .collect::<Vec<_>>();
        for expected in [
            "outlook-summary",
            "outlook-oos-equity",
            "outlook-quantile-paths",
            "outlook-calibration",
            "outlook-worst-scenarios",
            "outlook-sensitivity",
            "outlook-market-regimes",
            "walk-forward",
            "monte-carlo-distribution",
            "scenario-comparison",
            "screening-candidates",
            "ledger-validated-candidates",
        ] {
            assert!(artifact_types.contains(&expected), "missing {expected}");
        }
        let regime = output
            .artifacts
            .as_ref()
            .unwrap()
            .iter()
            .find(|artifact| artifact.artifact_type == "outlook-market-regimes")
            .unwrap();
        let first = regime.content["observations"]
            .as_array()
            .unwrap()
            .first()
            .unwrap();
        assert!(first["basedOnThrough"].as_str().unwrap() < first["date"].as_str().unwrap());
    }
}
