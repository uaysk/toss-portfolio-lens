use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, bail, ensure};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::control::{ComputeControl, checkpoint};

const TRADING_DAYS_PER_YEAR: f64 = 252.0;
const DEFAULT_QUANTILES: [f64; 5] = [0.05, 0.25, 0.5, 0.75, 0.95];
const MAX_HORIZON_DAYS: usize = 25_200;
const MAX_PATH_STEPS: usize = 25_000_000;
const MAX_OUTPUT_POINTS: usize = 1_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonteCarloInput {
    price_series: Vec<InputPriceSeries>,
    weights: BTreeMap<String, f64>,
    initial_amount: f64,
    horizon_days: usize,
    path_count: usize,
    block_length: usize,
    seed: u64,
    #[serde(default)]
    goal_amount: Option<f64>,
    #[serde(default)]
    quantiles: Option<Vec<f64>>,
    #[serde(default)]
    sample_path_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct InputPriceSeries {
    key: String,
    points: Vec<InputPricePoint>,
}

#[derive(Debug, Deserialize)]
struct InputPricePoint {
    date: String,
    value: f64,
}

#[derive(Debug)]
struct AlignedReturns {
    start_date: String,
    end_date: String,
    dates: Vec<String>,
    portfolio_returns: Vec<f64>,
    normalized_weights: BTreeMap<String, f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuantileValue {
    quantile: f64,
    value: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Distribution {
    count: usize,
    min: f64,
    max: f64,
    mean: f64,
    standard_deviation: f64,
    percentiles: Vec<QuantileValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathPoint {
    step: usize,
    balance: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PercentilePath {
    quantile: f64,
    points: Vec<PathPoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SamplePath {
    path_index: usize,
    points: Vec<PathPoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbabilitySummary {
    terminal_loss_probability_percent: f64,
    ever_depleted_probability_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_goal_probability_percent: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DistributionSummary {
    terminal_balance: Distribution,
    total_return_percent: Distribution,
    cagr_percent: Distribution,
    max_drawdown_percent: Distribution,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonteCarloOutput {
    method: &'static str,
    rng: &'static str,
    seed: u64,
    initial_amount: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    goal_amount: Option<f64>,
    horizon_days: usize,
    annualization_days: usize,
    path_count: usize,
    block_length: usize,
    historical_observation_count: usize,
    aligned_start_date: String,
    aligned_end_date: String,
    normalized_weights: BTreeMap<String, f64>,
    quantiles: Vec<f64>,
    distributions: DistributionSummary,
    probabilities: ProbabilitySummary,
    percentile_paths: Vec<PercentilePath>,
    sample_paths: Vec<SamplePath>,
    warnings: Vec<String>,
}

/// Runs a correlated moving-block bootstrap over historical, inner-joined asset returns.
///
/// Simulation state is held as one balance/high-water-mark/drawdown tuple per path. The
/// complete path matrix is never retained: requested sample paths and per-step percentile
/// results are the only time-series outputs kept in memory.
pub fn simulate(input: &Value) -> Result<Value> {
    simulate_with_control(input, None)
}

pub fn simulate_with_control(input: &Value, control: Option<&dyn ComputeControl>) -> Result<Value> {
    checkpoint(control)?;
    let parsed: MonteCarloInput =
        serde_json::from_value(input.clone()).context("invalid Monte Carlo input")?;
    validate_input(&parsed)?;

    let quantiles = normalize_quantiles(parsed.quantiles)?;
    let sample_path_count = parsed.sample_path_count.unwrap_or(10);
    ensure!(
        sample_path_count <= 100,
        "samplePathCount must be between 0 and 100"
    );
    ensure!(
        sample_path_count <= parsed.path_count,
        "samplePathCount cannot exceed pathCount"
    );
    ensure!(
        parsed.path_count.saturating_mul(parsed.horizon_days) <= MAX_PATH_STEPS,
        "pathCount * horizonDays exceeds the {MAX_PATH_STEPS} path-step work limit"
    );
    ensure!(
        (sample_path_count + quantiles.len()).saturating_mul(parsed.horizon_days + 1)
            <= MAX_OUTPUT_POINTS,
        "requested percentile/sample paths exceed the {MAX_OUTPUT_POINTS} output-point limit"
    );

    let (aligned, warnings) = align_returns(&parsed.price_series, &parsed.weights)?;
    checkpoint(control)?;
    ensure!(
        aligned.portfolio_returns.len() >= parsed.block_length,
        "blockLength ({}) exceeds the {} aligned historical return observations",
        parsed.block_length,
        aligned.portfolio_returns.len()
    );

    let path_count = parsed.path_count;
    let initial_amount = parsed.initial_amount;
    let mut balances = vec![initial_amount; path_count];
    let mut peaks = vec![initial_amount; path_count];
    let mut max_drawdowns = vec![0.0_f64; path_count];
    let mut depleted = vec![false; path_count];
    let mut percentile_paths = quantiles
        .iter()
        .copied()
        .map(|quantile| PercentilePath {
            quantile,
            points: vec![PathPoint {
                step: 0,
                balance: initial_amount,
            }],
        })
        .collect::<Vec<_>>();
    let mut sample_paths = (0..sample_path_count)
        .map(|path_index| SamplePath {
            path_index,
            points: vec![PathPoint {
                step: 0,
                balance: initial_amount,
            }],
        })
        .collect::<Vec<_>>();

    let block_start_count = aligned.portfolio_returns.len() - parsed.block_length + 1;
    for step in 0..parsed.horizon_days {
        checkpoint(control)?;
        let draw_index = step / parsed.block_length;
        let within_block = step % parsed.block_length;
        let invalid_balance = AtomicBool::new(false);

        balances
            .par_iter_mut()
            .zip(peaks.par_iter_mut())
            .zip(max_drawdowns.par_iter_mut())
            .zip(depleted.par_iter_mut())
            .enumerate()
            .try_for_each(
                |(path_index, (((balance, peak), maximum_drawdown), depleted_flag))| -> Result<()> {
                    if path_index.is_multiple_of(4_096) {
                        checkpoint(control)?;
                    }
                    let block_start = bounded_counter(
                        parsed.seed,
                        path_index as u64,
                        draw_index as u64,
                        block_start_count,
                    );
                    let daily_return = aligned.portfolio_returns[block_start + within_block];
                    *balance *= 1.0 + daily_return;
                    if !balance.is_finite() || *balance < 0.0 {
                        invalid_balance.store(true, Ordering::Relaxed);
                        return Ok(());
                    }
                    if *balance > *peak {
                        *peak = *balance;
                    }
                    let drawdown = if *peak > 0.0 {
                        (1.0 - *balance / *peak).max(0.0)
                    } else {
                        0.0
                    };
                    *maximum_drawdown = maximum_drawdown.max(drawdown);
                    *depleted_flag |= *balance == 0.0;
                    Ok(())
                },
            )?;
        checkpoint(control)?;

        ensure!(
            !invalid_balance.load(Ordering::Relaxed),
            "simulation produced a non-finite balance; reduce horizonDays or inspect price data"
        );

        let step_percentiles = percentile_values(&balances, &quantiles);
        for (path, balance) in percentile_paths.iter_mut().zip(step_percentiles) {
            path.points.push(PathPoint {
                step: step + 1,
                balance,
            });
        }
        for path in &mut sample_paths {
            path.points.push(PathPoint {
                step: step + 1,
                balance: balances[path.path_index],
            });
        }
    }

    let total_returns = balances
        .iter()
        .map(|balance| (balance / initial_amount - 1.0) * 100.0)
        .collect::<Vec<_>>();
    checkpoint(control)?;
    let annualization_exponent = TRADING_DAYS_PER_YEAR / parsed.horizon_days as f64;
    let cagrs = balances
        .iter()
        .map(|balance| {
            let growth = balance / initial_amount;
            if growth == 0.0 {
                -100.0
            } else {
                (growth.powf(annualization_exponent) - 1.0) * 100.0
            }
        })
        .collect::<Vec<_>>();
    ensure!(
        cagrs.iter().all(|value| value.is_finite()),
        "simulation produced a non-finite CAGR; reduce horizonDays or inspect price data"
    );
    let max_drawdown_percent = max_drawdowns
        .iter()
        .map(|value| value * 100.0)
        .collect::<Vec<_>>();

    let probability_denominator = path_count as f64;
    let loss_count = balances
        .iter()
        .filter(|balance| **balance < initial_amount)
        .count();
    let depletion_count = depleted.iter().filter(|value| **value).count();
    let goal_probability_percent = parsed.goal_amount.map(|goal| {
        balances.iter().filter(|balance| **balance >= goal).count() as f64 / probability_denominator
            * 100.0
    });
    let terminal_balance_distribution = distribution(&balances, &quantiles);
    checkpoint(control)?;
    let total_return_distribution = distribution(&total_returns, &quantiles);
    checkpoint(control)?;
    let cagr_distribution = distribution(&cagrs, &quantiles);
    checkpoint(control)?;
    let max_drawdown_distribution = distribution(&max_drawdown_percent, &quantiles);
    checkpoint(control)?;

    let output = MonteCarloOutput {
        method: "correlated_moving_block_bootstrap",
        rng: "counter_based_splitmix64",
        seed: parsed.seed,
        initial_amount,
        goal_amount: parsed.goal_amount,
        horizon_days: parsed.horizon_days,
        annualization_days: TRADING_DAYS_PER_YEAR as usize,
        path_count,
        block_length: parsed.block_length,
        historical_observation_count: aligned.dates.len(),
        aligned_start_date: aligned.start_date,
        aligned_end_date: aligned.end_date,
        normalized_weights: aligned.normalized_weights,
        quantiles: quantiles.clone(),
        distributions: DistributionSummary {
            terminal_balance: terminal_balance_distribution,
            total_return_percent: total_return_distribution,
            cagr_percent: cagr_distribution,
            max_drawdown_percent: max_drawdown_distribution,
        },
        probabilities: ProbabilitySummary {
            terminal_loss_probability_percent: loss_count as f64 / probability_denominator * 100.0,
            ever_depleted_probability_percent: depletion_count as f64 / probability_denominator
                * 100.0,
            terminal_goal_probability_percent: goal_probability_percent,
        },
        percentile_paths,
        sample_paths,
        warnings,
    };

    checkpoint(control)?;
    serde_json::to_value(output).context("failed to serialize Monte Carlo output")
}

fn validate_input(input: &MonteCarloInput) -> Result<()> {
    ensure!(
        input.initial_amount.is_finite() && input.initial_amount > 0.0,
        "initialAmount must be a finite positive number"
    );
    ensure!(
        (1..=MAX_HORIZON_DAYS).contains(&input.horizon_days),
        "horizonDays must be between 1 and {MAX_HORIZON_DAYS}"
    );
    ensure!(
        (100..=100_000).contains(&input.path_count),
        "pathCount must be between 100 and 100000"
    );
    ensure!(
        (1..=252).contains(&input.block_length),
        "blockLength must be between 1 and 252"
    );
    if let Some(goal) = input.goal_amount {
        ensure!(
            goal.is_finite() && goal >= 0.0,
            "goalAmount must be a finite non-negative number"
        );
    }
    ensure!(
        !input.price_series.is_empty(),
        "priceSeries cannot be empty"
    );
    ensure!(!input.weights.is_empty(), "weights cannot be empty");
    Ok(())
}

fn normalize_quantiles(quantiles: Option<Vec<f64>>) -> Result<Vec<f64>> {
    let mut values = quantiles.unwrap_or_else(|| DEFAULT_QUANTILES.to_vec());
    ensure!(!values.is_empty(), "quantiles cannot be empty");
    for quantile in &values {
        ensure!(
            quantile.is_finite() && *quantile > 0.0 && *quantile < 1.0,
            "each quantile must be a finite number strictly between 0 and 1"
        );
    }
    values.sort_by(f64::total_cmp);
    values.dedup_by(|left, right| left.total_cmp(right).is_eq());
    Ok(values)
}

fn align_returns(
    price_series: &[InputPriceSeries],
    input_weights: &BTreeMap<String, f64>,
) -> Result<(AlignedReturns, Vec<String>)> {
    let mut returns_by_key = BTreeMap::<String, BTreeMap<String, f64>>::new();
    for series in price_series {
        ensure!(
            !series.key.trim().is_empty(),
            "priceSeries key cannot be empty"
        );
        ensure!(
            !returns_by_key.contains_key(&series.key),
            "duplicate priceSeries key: {}",
            series.key
        );
        ensure!(
            series.points.len() >= 2,
            "priceSeries {} must contain at least two points",
            series.key
        );

        let mut prices = BTreeMap::<String, f64>::new();
        for point in &series.points {
            crate::date::parse_iso_date(&point.date)
                .with_context(|| format!("invalid date in priceSeries {}", series.key))?;
            ensure!(
                point.value.is_finite() && point.value > 0.0,
                "priceSeries {} contains a non-finite or non-positive price on {}",
                series.key,
                point.date
            );
            ensure!(
                prices.insert(point.date.clone(), point.value).is_none(),
                "priceSeries {} contains duplicate date {}",
                series.key,
                point.date
            );
        }

        let mut previous: Option<f64> = None;
        let mut returns = BTreeMap::new();
        for (date, price) in prices {
            if let Some(previous_price) = previous {
                let daily_return = price / previous_price - 1.0;
                ensure!(
                    daily_return.is_finite() && daily_return > -1.0,
                    "priceSeries {} produced an invalid return on {}",
                    series.key,
                    date
                );
                returns.insert(date, daily_return);
            }
            previous = Some(price);
        }
        returns_by_key.insert(series.key.clone(), returns);
    }

    let mut active_weights = BTreeMap::new();
    let mut weight_sum = 0.0;
    for (key, weight) in input_weights {
        ensure!(
            weight.is_finite() && *weight >= 0.0,
            "weight for {key} must be finite and non-negative"
        );
        ensure!(
            returns_by_key.contains_key(key),
            "weight references missing priceSeries key: {key}"
        );
        if *weight > 0.0 {
            active_weights.insert(key.clone(), *weight);
            weight_sum += *weight;
        }
    }
    ensure!(
        !active_weights.is_empty() && weight_sum.is_finite(),
        "at least one asset must have a positive weight"
    );

    let mut warnings = Vec::new();
    let scale = if (weight_sum - 1.0).abs() <= 1e-6 {
        1.0
    } else if (weight_sum - 100.0).abs() <= 1e-4 {
        warnings.push("weights were interpreted as percentages and converted to fractions".into());
        100.0
    } else {
        bail!("positive weights must sum to 1.0 (fractions) or 100.0 (percentages)");
    };
    for weight in active_weights.values_mut() {
        *weight /= scale;
    }

    let first_key = active_weights
        .keys()
        .next()
        .context("no active weight after validation")?;
    let first_returns = returns_by_key
        .get(first_key)
        .context("active price series disappeared during alignment")?;
    let mut dates = Vec::new();
    let mut portfolio_returns = Vec::new();
    for date in first_returns.keys() {
        if !active_weights.keys().all(|key| {
            returns_by_key
                .get(key)
                .is_some_and(|returns| returns.contains_key(date))
        }) {
            continue;
        }
        let mut portfolio_return = 0.0;
        for (key, weight) in &active_weights {
            portfolio_return += weight * returns_by_key[key][date];
        }
        ensure!(
            portfolio_return.is_finite() && portfolio_return > -1.0,
            "aligned portfolio return is invalid on {date}"
        );
        dates.push(date.clone());
        portfolio_returns.push(portfolio_return);
    }
    ensure!(
        !dates.is_empty(),
        "priceSeries have no common return dates after inner join"
    );

    Ok((
        AlignedReturns {
            start_date: dates[0].clone(),
            end_date: dates[dates.len() - 1].clone(),
            dates,
            portfolio_returns,
            normalized_weights: active_weights,
        },
        warnings,
    ))
}

/// SplitMix64 finalizer applied to an explicit `(seed, path, draw)` counter tuple.
/// No mutable RNG state is shared between paths, so scheduling cannot affect a draw.
fn counter_random(seed: u64, path_index: u64, draw_index: u64) -> u64 {
    let path = mix64(path_index ^ 0xD1B5_4A32_D192_ED03);
    let draw = mix64(draw_index ^ 0x94D0_49BB_1331_11EB).rotate_left(29);
    mix64(seed ^ path ^ draw)
}

fn mix64(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^ (value >> 31)
}

fn bounded_counter(seed: u64, path_index: u64, draw_index: u64, upper: usize) -> usize {
    debug_assert!(upper > 0);
    ((counter_random(seed, path_index, draw_index) as u128 * upper as u128) >> 64) as usize
}

fn distribution(values: &[f64], quantiles: &[f64]) -> Distribution {
    debug_assert!(!values.is_empty());
    let mut mean = 0.0;
    let mut second_moment = 0.0;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for (index, value) in values.iter().copied().enumerate() {
        min = min.min(value);
        max = max.max(value);
        let count = (index + 1) as f64;
        let delta = value - mean;
        mean += delta / count;
        second_moment += delta * (value - mean);
    }
    let percentile_values = percentile_values(values, quantiles);
    Distribution {
        count: values.len(),
        min,
        max,
        mean,
        standard_deviation: (second_moment / values.len() as f64).max(0.0).sqrt(),
        percentiles: quantiles
            .iter()
            .copied()
            .zip(percentile_values)
            .map(|(quantile, value)| QuantileValue { quantile, value })
            .collect(),
    }
}

/// Exact linear-interpolated quantiles using only one scratch vector for the current step.
fn percentile_values(values: &[f64], quantiles: &[f64]) -> Vec<f64> {
    debug_assert!(!values.is_empty());
    let last_index = values.len() - 1;
    let positions = quantiles
        .iter()
        .map(|quantile| {
            let index = quantile * last_index as f64;
            (index.floor() as usize, index.ceil() as usize, index.fract())
        })
        .collect::<Vec<_>>();
    let ranks = positions
        .iter()
        .flat_map(|(lower, upper, _)| [*lower, *upper])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut scratch = values.to_vec();
    let mut selected = BTreeMap::new();
    select_ranks(&mut scratch, 0, &ranks, &mut selected);
    positions
        .into_iter()
        .map(|(lower, upper, fraction)| {
            selected[&lower] * (1.0 - fraction) + selected[&upper] * fraction
        })
        .collect()
}

fn select_ranks(
    values: &mut [f64],
    base_index: usize,
    ranks: &[usize],
    selected: &mut BTreeMap<usize, f64>,
) {
    if ranks.is_empty() {
        return;
    }
    let middle = ranks.len() / 2;
    let rank = ranks[middle];
    let local_rank = rank - base_index;
    let (left, pivot, right) = values.select_nth_unstable_by(local_rank, f64::total_cmp);
    selected.insert(rank, *pivot);
    select_ranks(left, base_index, &ranks[..middle], selected);
    select_ranks(right, rank + 1, &ranks[middle + 1..], selected);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use rayon::ThreadPoolBuilder;
    use serde_json::json;

    use super::*;

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
                anyhow::bail!("TEST_COMPUTE_CANCELLED");
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

    fn flat_input() -> Value {
        json!({
            "priceSeries": [
                {
                    "key": "A",
                    "points": [
                        { "date": "2024-01-01", "value": 100.0 },
                        { "date": "2024-01-02", "value": 100.0 },
                        { "date": "2024-01-03", "value": 100.0 },
                        { "date": "2024-01-04", "value": 100.0 }
                    ]
                },
                {
                    "key": "B",
                    "points": [
                        { "date": "2024-01-01", "value": 200.0 },
                        { "date": "2024-01-02", "value": 200.0 },
                        { "date": "2024-01-03", "value": 200.0 },
                        { "date": "2024-01-04", "value": 200.0 }
                    ]
                }
            ],
            "weights": { "A": 0.6, "B": 0.4 },
            "initialAmount": 1000.0,
            "horizonDays": 10,
            "pathCount": 100,
            "blockLength": 2,
            "seed": 42,
            "goalAmount": 1000.0,
            "quantiles": [0.05, 0.5, 0.95],
            "samplePathCount": 2
        })
    }

    fn variable_input() -> Value {
        json!({
            "priceSeries": [
                {
                    "key": "A",
                    "points": [
                        { "date": "2024-01-01", "value": 100.0 },
                        { "date": "2024-01-02", "value": 104.0 },
                        { "date": "2024-01-03", "value": 101.0 },
                        { "date": "2024-01-04", "value": 109.0 },
                        { "date": "2024-01-05", "value": 105.0 },
                        { "date": "2024-01-06", "value": 113.0 }
                    ]
                },
                {
                    "key": "B",
                    "points": [
                        { "date": "2024-01-01", "value": 80.0 },
                        { "date": "2024-01-02", "value": 79.0 },
                        { "date": "2024-01-03", "value": 83.0 },
                        { "date": "2024-01-04", "value": 81.0 },
                        { "date": "2024-01-05", "value": 86.0 },
                        { "date": "2024-01-06", "value": 84.0 }
                    ]
                }
            ],
            "weights": { "A": 0.7, "B": 0.3 },
            "initialAmount": 10000.0,
            "horizonDays": 25,
            "pathCount": 100,
            "blockLength": 2,
            "seed": 912345678_u64,
            "goalAmount": 11000.0,
            "quantiles": [0.1, 0.5, 0.9],
            "samplePathCount": 3
        })
    }

    #[test]
    fn zero_returns_keep_every_path_flat() {
        let output = simulate(&flat_input()).unwrap();
        assert_eq!(output["distributions"]["terminalBalance"]["mean"], 1000.0);
        assert_eq!(output["distributions"]["totalReturnPercent"]["mean"], 0.0);
        assert_eq!(output["distributions"]["cagrPercent"]["mean"], 0.0);
        assert_eq!(output["distributions"]["maxDrawdownPercent"]["max"], 0.0);
        assert_eq!(
            output["probabilities"]["terminalLossProbabilityPercent"],
            0.0
        );
        assert_eq!(
            output["probabilities"]["everDepletedProbabilityPercent"],
            0.0
        );
        assert_eq!(
            output["probabilities"]["terminalGoalProbabilityPercent"],
            100.0
        );
        assert!(
            output["percentilePaths"]
                .as_array()
                .unwrap()
                .iter()
                .all(|path| {
                    path["points"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|point| point["balance"] == 1000.0)
                })
        );
    }

    #[test]
    fn seed_is_deterministic_and_changes_the_result() {
        let first = simulate(&variable_input()).unwrap();
        let second = simulate(&variable_input()).unwrap();
        assert_eq!(first, second);

        let mut changed = variable_input();
        changed["seed"] = json!(912345679_u64);
        let changed = simulate(&changed).unwrap();
        assert_ne!(first["samplePaths"], changed["samplePaths"]);
    }

    #[test]
    fn rayon_thread_count_does_not_change_output() {
        let input = variable_input();
        let single = ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap()
            .install(|| simulate(&input).unwrap());
        let four = ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap()
            .install(|| simulate(&input).unwrap());
        assert_eq!(single, four);
    }

    #[test]
    fn rejects_excessive_path_steps_and_output_points() {
        let mut work = flat_input();
        work["pathCount"] = json!(100_000);
        work["horizonDays"] = json!(1_000);
        assert!(
            simulate(&work)
                .unwrap_err()
                .to_string()
                .contains("path-step")
        );

        let mut output = flat_input();
        output["pathCount"] = json!(100);
        output["horizonDays"] = json!(10_000);
        output["samplePathCount"] = json!(100);
        assert!(
            simulate(&output)
                .unwrap_err()
                .to_string()
                .contains("output-point")
        );
    }

    #[test]
    fn cooperative_control_stops_without_partial_output_and_preserves_normal_results() {
        let input = variable_input();
        let expected = simulate(&input).unwrap();
        let controlled = simulate_with_control(&input, Some(&NeverStop)).unwrap();
        assert_eq!(controlled, expected);

        let control = StopAfter {
            remaining: AtomicUsize::new(3),
        };
        assert!(
            simulate_with_control(&input, Some(&control))
                .unwrap_err()
                .to_string()
                .contains("TEST_COMPUTE_CANCELLED")
        );
    }
}
