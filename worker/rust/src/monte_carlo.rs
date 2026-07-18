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
const MAX_CALIBRATION_HORIZON_DAYS: usize = 252;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SimulationMethod {
    #[default]
    MovingBlock,
    Stationary,
    RegimeConditioned,
    StudentT,
}

impl SimulationMethod {
    const fn label(self) -> &'static str {
        match self {
            Self::MovingBlock => "correlated_moving_block_bootstrap",
            Self::Stationary => "correlated_stationary_bootstrap",
            Self::RegimeConditioned => "correlated_regime_conditioned_bootstrap",
            Self::StudentT => "fitted_multivariate_student_t",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RebalanceFrequency {
    #[default]
    None,
    Monthly,
    Quarterly,
    Annually,
    Threshold,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum QuantityMode {
    #[default]
    Fractional,
    Whole,
}

const fn default_student_t_degrees_of_freedom() -> f64 {
    7.0
}

const fn default_cash_flow_frequency_days() -> usize {
    21
}

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
    #[serde(default)]
    method: SimulationMethod,
    #[serde(default)]
    stationary_restart_probability: Option<f64>,
    #[serde(default = "default_student_t_degrees_of_freedom")]
    student_t_degrees_of_freedom: f64,
    #[serde(default)]
    rebalance_frequency: RebalanceFrequency,
    #[serde(default)]
    rebalance_threshold_percent: Option<f64>,
    #[serde(default)]
    cash_weight: f64,
    #[serde(default)]
    cash_annual_yield_percent: f64,
    #[serde(default)]
    transaction_cost_bps: f64,
    #[serde(default)]
    periodic_cash_flow: f64,
    #[serde(default = "default_cash_flow_frequency_days")]
    cash_flow_frequency_days: usize,
    #[serde(default)]
    inflation_annual_percent: f64,
    #[serde(default)]
    quantity_mode: QuantityMode,
    #[serde(default)]
    lot_sizes: BTreeMap<String, f64>,
    #[serde(default)]
    calibration_origins: usize,
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
    keys: Vec<String>,
    asset_returns: Vec<Vec<f64>>,
    ending_prices: Vec<f64>,
    normalized_weights: BTreeMap<String, f64>,
}

#[derive(Debug)]
struct RegimeModel {
    indices: [Vec<usize>; 3],
    transition_probabilities: [[f64; 3]; 3],
    initial_probabilities: [f64; 3],
    degenerate: bool,
}

#[derive(Debug)]
struct StudentTModel {
    means: Vec<f64>,
    cholesky: Vec<Vec<f64>>,
}

enum SampledAssetReturns<'a> {
    Historical(&'a [f64]),
    Parametric(Vec<f64>),
}

impl AsRef<[f64]> for SampledAssetReturns<'_> {
    fn as_ref(&self) -> &[f64] {
        match self {
            Self::Historical(value) => value,
            Self::Parametric(value) => value,
        }
    }
}

#[derive(Debug)]
struct PathState {
    quantities: Vec<f64>,
    prices: Vec<f64>,
    cash: f64,
    peak: f64,
    maximum_drawdown: f64,
    ever_depleted: bool,
    sampled_index: usize,
    regime: usize,
    contributions: f64,
    withdrawals: f64,
    cash_yield: f64,
    transaction_costs: f64,
    turnover: f64,
    rebalance_count: usize,
    maximum_conservation_error: f64,
}

impl PathState {
    fn balance(&self) -> f64 {
        self.cash
            + self
                .quantities
                .iter()
                .zip(&self.prices)
                .map(|(quantity, price)| quantity * price)
                .sum::<f64>()
    }
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
    /// Probability that terminal wealth plus prior withdrawals is below the
    /// initial capital plus contributions. This keeps external cash flows from
    /// being misclassified as investment gains or losses.
    terminal_loss_probability_percent: f64,
    /// Legacy/raw diagnostic: terminal balance alone is below initial capital.
    terminal_balance_below_initial_probability_percent: f64,
    terminal_loss_basis: &'static str,
    ever_depleted_probability_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_goal_probability_percent: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DistributionSummary {
    terminal_balance: Distribution,
    inflation_adjusted_terminal_balance: Distribution,
    total_return_percent: Distribution,
    cash_flow_adjusted_terminal_return_percent: Distribution,
    cagr_percent: Distribution,
    max_drawdown_percent: Distribution,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerSummary {
    quantity_mode: QuantityMode,
    lot_sizes: BTreeMap<String, f64>,
    contributions: Distribution,
    withdrawals: Distribution,
    cash_yield: Distribution,
    transaction_costs: Distribution,
    turnover: Distribution,
    rebalance_count: Distribution,
    terminal_cash: Distribution,
    terminal_invested: Distribution,
    maximum_conservation_error: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationObservation {
    origin_date: String,
    target_date: String,
    horizon_days: usize,
    actual_return_percent: f64,
    predicted_median_return_percent: f64,
    lower_return_percent: f64,
    upper_return_percent: f64,
    covered: bool,
    bias_percent: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationSummary {
    status: &'static str,
    requested_origins: usize,
    evaluated_origins: usize,
    path_count_per_origin: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    lower_quantile: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upper_quantile: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    coverage_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    coverage_score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bias_percent: Option<f64>,
    observations: Vec<CalibrationObservation>,
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
    cash_weight: f64,
    cash_annual_yield_percent: f64,
    rebalance_frequency: RebalanceFrequency,
    #[serde(skip_serializing_if = "Option::is_none")]
    rebalance_threshold_percent: Option<f64>,
    transaction_cost_bps: f64,
    periodic_cash_flow: f64,
    cash_flow_frequency_days: usize,
    inflation_annual_percent: f64,
    cash_flow_adjusted_return_basis: &'static str,
    quantiles: Vec<f64>,
    distributions: DistributionSummary,
    probabilities: ProbabilitySummary,
    ledger: LedgerSummary,
    calibration: CalibrationSummary,
    percentile_paths: Vec<PercentilePath>,
    sample_paths: Vec<SamplePath>,
    warnings: Vec<String>,
}

/// Runs a deterministic correlated return simulation with a cash/quantity-aware ledger.
///
/// The full path matrix is never retained. Each path keeps only its current holdings and
/// aggregate ledger totals; requested sample paths and per-step percentiles are the only
/// time-series outputs materialized.
pub fn simulate(input: &Value) -> Result<Value> {
    simulate_with_control(input, None)
}

pub fn simulate_with_control(input: &Value, control: Option<&dyn ComputeControl>) -> Result<Value> {
    checkpoint(control)?;
    let parsed: MonteCarloInput =
        serde_json::from_value(input.clone()).context("invalid Monte Carlo input")?;
    validate_input(&parsed)?;

    let quantiles = normalize_quantiles(parsed.quantiles.clone())?;
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

    let (aligned, mut warnings) = align_returns(&parsed.price_series, &parsed.weights)?;
    checkpoint(control)?;
    ensure!(
        aligned.portfolio_returns.len() >= parsed.block_length,
        "blockLength ({}) exceeds the {} aligned historical return observations",
        parsed.block_length,
        aligned.portfolio_returns.len()
    );

    let restart_probability = parsed
        .stationary_restart_probability
        .unwrap_or(1.0 / parsed.block_length as f64);
    let regime_model = build_regime_model(&aligned.portfolio_returns);
    let student_t_model = build_student_t_model(&aligned.asset_returns)?;
    if parsed.method == SimulationMethod::RegimeConditioned && regime_model.degenerate {
        warnings.push(
            "regime-conditioned bootstrap has a degenerate historical regime; empty regimes fall back to all observations"
                .into(),
        );
    }
    if parsed.method == SimulationMethod::StudentT {
        warnings.push(
            "student_t is a covariance-fitted elliptical model; historical skew and regime persistence are not preserved"
                .into(),
        );
    }
    if parsed.quantity_mode == QuantityMode::Whole {
        warnings.push(
            "whole quantity simulation uses the last aligned adjusted price and configured lot sizes; future corporate-action lot changes are unavailable"
                .into(),
        );
    }
    if parsed.periodic_cash_flow != 0.0 {
        warnings.push(
            "total return, CAGR, and terminalBalanceBelowInitialProbabilityPercent are cash-flow-naive; cashFlowAdjustedTerminalReturnPercent uses terminal balance plus withdrawals versus initial capital plus contributions without cash-flow timing; terminalLossProbabilityPercent uses the same external-flow-adjusted comparison"
                .into(),
        );
    }

    let path_count = parsed.path_count;
    let initial_amount = parsed.initial_amount;
    let lot_sizes = normalized_lot_sizes(&parsed, &aligned)?;
    let mut states = (0..path_count)
        .map(|path_index| initialize_path(path_index, &parsed, &aligned, &lot_sizes, &regime_model))
        .collect::<Result<Vec<_>>>()?;
    let mut balances = states.iter().map(PathState::balance).collect::<Vec<_>>();
    let opening_percentiles = percentile_values(&balances, &quantiles);
    let mut percentile_paths = quantiles
        .iter()
        .copied()
        .zip(opening_percentiles)
        .map(|(quantile, balance)| PercentilePath {
            quantile,
            points: vec![PathPoint { step: 0, balance }],
        })
        .collect::<Vec<_>>();
    let mut sample_paths = (0..sample_path_count)
        .map(|path_index| SamplePath {
            path_index,
            points: vec![PathPoint {
                step: 0,
                balance: balances[path_index],
            }],
        })
        .collect::<Vec<_>>();

    for step in 0..parsed.horizon_days {
        checkpoint(control)?;
        let invalid_balance = AtomicBool::new(false);

        states
            .par_iter_mut()
            .enumerate()
            .try_for_each(|(path_index, state)| -> Result<()> {
                if path_index.is_multiple_of(4_096) {
                    checkpoint(control)?;
                }
                let sampled_returns = sample_asset_returns(
                    &parsed,
                    &aligned,
                    &regime_model,
                    &student_t_model,
                    restart_probability,
                    state,
                    path_index,
                    step,
                );
                advance_path(
                    state,
                    sampled_returns.as_ref(),
                    &parsed,
                    &aligned,
                    &lot_sizes,
                    step,
                );
                let balance = state.balance();
                if !balance.is_finite() || balance < -1e-7 {
                    invalid_balance.store(true, Ordering::Relaxed);
                    return Ok(());
                }
                Ok(())
            })?;
        checkpoint(control)?;

        ensure!(
            !invalid_balance.load(Ordering::Relaxed),
            "simulation produced a non-finite balance; reduce horizonDays or inspect price data"
        );

        balances = states.iter().map(PathState::balance).collect();
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
    let cash_flow_adjusted_terminal_returns = balances
        .iter()
        .zip(&states)
        .map(|(balance, state)| {
            let supplied_capital = initial_amount + state.contributions;
            ((balance + state.withdrawals) / supplied_capital - 1.0) * 100.0
        })
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
    let max_drawdown_percent = states
        .iter()
        .map(|state| state.maximum_drawdown * 100.0)
        .collect::<Vec<_>>();
    let terminal_inflation_factor =
        annual_growth_factor(parsed.inflation_annual_percent, parsed.horizon_days);
    let inflation_adjusted_balances = balances
        .iter()
        .map(|balance| balance / terminal_inflation_factor)
        .collect::<Vec<_>>();

    let probability_denominator = path_count as f64;
    let raw_terminal_loss_count = balances
        .iter()
        .filter(|balance| **balance < initial_amount)
        .count();
    let cash_flow_adjusted_loss_count = balances
        .iter()
        .zip(&states)
        .filter(|(balance, state)| {
            is_cash_flow_adjusted_terminal_loss(
                **balance,
                initial_amount,
                state.contributions,
                state.withdrawals,
            )
        })
        .count();
    let depletion_count = states.iter().filter(|state| state.ever_depleted).count();
    let goal_probability_percent = parsed.goal_amount.map(|goal| {
        balances.iter().filter(|balance| **balance >= goal).count() as f64 / probability_denominator
            * 100.0
    });
    let terminal_balance_distribution = distribution(&balances, &quantiles);
    checkpoint(control)?;
    let inflation_adjusted_terminal_balance_distribution =
        distribution(&inflation_adjusted_balances, &quantiles);
    checkpoint(control)?;
    let total_return_distribution = distribution(&total_returns, &quantiles);
    checkpoint(control)?;
    let cash_flow_adjusted_terminal_return_distribution =
        distribution(&cash_flow_adjusted_terminal_returns, &quantiles);
    checkpoint(control)?;
    let cagr_distribution = distribution(&cagrs, &quantiles);
    checkpoint(control)?;
    let max_drawdown_distribution = distribution(&max_drawdown_percent, &quantiles);
    checkpoint(control)?;
    let contributions = states
        .iter()
        .map(|state| state.contributions)
        .collect::<Vec<_>>();
    let withdrawals = states
        .iter()
        .map(|state| state.withdrawals)
        .collect::<Vec<_>>();
    let cash_yields = states
        .iter()
        .map(|state| state.cash_yield)
        .collect::<Vec<_>>();
    let transaction_costs = states
        .iter()
        .map(|state| state.transaction_costs)
        .collect::<Vec<_>>();
    let turnovers = states
        .iter()
        .map(|state| state.turnover)
        .collect::<Vec<_>>();
    let rebalance_counts = states
        .iter()
        .map(|state| state.rebalance_count as f64)
        .collect::<Vec<_>>();
    let terminal_cash = states.iter().map(|state| state.cash).collect::<Vec<_>>();
    let terminal_invested = states
        .iter()
        .map(|state| state.balance() - state.cash)
        .collect::<Vec<_>>();
    let maximum_conservation_error = states
        .iter()
        .map(|state| state.maximum_conservation_error)
        .max_by(f64::total_cmp)
        .unwrap_or(0.0);
    let calibration = calibrate_history(&parsed, &aligned, &quantiles, &mut warnings)?;
    checkpoint(control)?;

    let output = MonteCarloOutput {
        method: parsed.method.label(),
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
        cash_weight: parsed.cash_weight,
        cash_annual_yield_percent: parsed.cash_annual_yield_percent,
        rebalance_frequency: parsed.rebalance_frequency,
        rebalance_threshold_percent: parsed.rebalance_threshold_percent,
        transaction_cost_bps: parsed.transaction_cost_bps,
        periodic_cash_flow: parsed.periodic_cash_flow,
        cash_flow_frequency_days: parsed.cash_flow_frequency_days,
        inflation_annual_percent: parsed.inflation_annual_percent,
        cash_flow_adjusted_return_basis: "(terminal_balance_plus_withdrawals)/(initial_capital_plus_contributions)-1;cash_flow_timing_not_weighted",
        quantiles: quantiles.clone(),
        distributions: DistributionSummary {
            terminal_balance: terminal_balance_distribution,
            inflation_adjusted_terminal_balance: inflation_adjusted_terminal_balance_distribution,
            total_return_percent: total_return_distribution,
            cash_flow_adjusted_terminal_return_percent:
                cash_flow_adjusted_terminal_return_distribution,
            cagr_percent: cagr_distribution,
            max_drawdown_percent: max_drawdown_distribution,
        },
        probabilities: ProbabilitySummary {
            terminal_loss_probability_percent: cash_flow_adjusted_loss_count as f64
                / probability_denominator
                * 100.0,
            terminal_balance_below_initial_probability_percent: raw_terminal_loss_count as f64
                / probability_denominator
                * 100.0,
            terminal_loss_basis: "terminal_balance_plus_withdrawals_below_initial_capital_plus_contributions",
            ever_depleted_probability_percent: depletion_count as f64 / probability_denominator
                * 100.0,
            terminal_goal_probability_percent: goal_probability_percent,
        },
        ledger: LedgerSummary {
            quantity_mode: parsed.quantity_mode,
            lot_sizes,
            contributions: distribution(&contributions, &quantiles),
            withdrawals: distribution(&withdrawals, &quantiles),
            cash_yield: distribution(&cash_yields, &quantiles),
            transaction_costs: distribution(&transaction_costs, &quantiles),
            turnover: distribution(&turnovers, &quantiles),
            rebalance_count: distribution(&rebalance_counts, &quantiles),
            terminal_cash: distribution(&terminal_cash, &quantiles),
            terminal_invested: distribution(&terminal_invested, &quantiles),
            maximum_conservation_error,
        },
        calibration,
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
    if let Some(probability) = input.stationary_restart_probability {
        ensure!(
            probability.is_finite() && probability > 0.0 && probability <= 1.0,
            "stationaryRestartProbability must be in (0, 1]"
        );
    }
    ensure!(
        input.student_t_degrees_of_freedom.is_finite()
            && input.student_t_degrees_of_freedom > 2.0
            && input.student_t_degrees_of_freedom <= 100.0,
        "studentTDegreesOfFreedom must be in (2, 100]"
    );
    ensure!(
        input.cash_weight.is_finite() && input.cash_weight >= 0.0 && input.cash_weight < 1.0,
        "cashWeight must be in [0, 1)"
    );
    ensure!(
        input.cash_annual_yield_percent.is_finite() && input.cash_annual_yield_percent >= -100.0,
        "cashAnnualYieldPercent must be finite and at least -100"
    );
    ensure!(
        input.transaction_cost_bps.is_finite()
            && (0.0..=500.0).contains(&input.transaction_cost_bps),
        "transactionCostBps must be between 0 and 500"
    );
    ensure!(
        input.periodic_cash_flow.is_finite(),
        "periodicCashFlow must be finite"
    );
    ensure!(
        (1..=MAX_HORIZON_DAYS).contains(&input.cash_flow_frequency_days),
        "cashFlowFrequencyDays must be between 1 and {MAX_HORIZON_DAYS}"
    );
    ensure!(
        input.inflation_annual_percent.is_finite()
            && input.inflation_annual_percent > -100.0
            && input.inflation_annual_percent <= 100.0,
        "inflationAnnualPercent must be in (-100, 100]"
    );
    if input.rebalance_frequency == RebalanceFrequency::Threshold {
        let threshold = input
            .rebalance_threshold_percent
            .context("rebalanceThresholdPercent is required for threshold rebalancing")?;
        ensure!(
            threshold.is_finite() && threshold > 0.0 && threshold <= 50.0,
            "rebalanceThresholdPercent must be in (0, 50]"
        );
    }
    ensure!(
        input.calibration_origins <= 100,
        "calibrationOrigins must be between 0 and 100"
    );
    for (key, lot_size) in &input.lot_sizes {
        ensure!(
            !key.trim().is_empty() && lot_size.is_finite() && *lot_size > 0.0,
            "lotSizes values must be finite positive numbers"
        );
    }
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
    let mut prices_by_key = BTreeMap::<String, BTreeMap<String, f64>>::new();
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
        for (date, price) in &prices {
            if let Some(previous_price) = previous {
                let daily_return = *price / previous_price - 1.0;
                ensure!(
                    daily_return.is_finite() && daily_return > -1.0,
                    "priceSeries {} produced an invalid return on {}",
                    series.key,
                    date
                );
                returns.insert(date.clone(), daily_return);
            }
            previous = Some(*price);
        }
        returns_by_key.insert(series.key.clone(), returns);
        prices_by_key.insert(series.key.clone(), prices);
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
    let mut asset_returns = Vec::new();
    let keys = active_weights.keys().cloned().collect::<Vec<_>>();
    for date in first_returns.keys() {
        if !active_weights.keys().all(|key| {
            returns_by_key
                .get(key)
                .is_some_and(|returns| returns.contains_key(date))
        }) {
            continue;
        }
        let mut portfolio_return = 0.0;
        let mut row = Vec::with_capacity(keys.len());
        for key in &keys {
            let asset_return = returns_by_key[key][date];
            portfolio_return += active_weights[key] * asset_return;
            row.push(asset_return);
        }
        ensure!(
            portfolio_return.is_finite() && portfolio_return > -1.0,
            "aligned portfolio return is invalid on {date}"
        );
        dates.push(date.clone());
        portfolio_returns.push(portfolio_return);
        asset_returns.push(row);
    }
    ensure!(
        !dates.is_empty(),
        "priceSeries have no common return dates after inner join"
    );

    let end_date = dates[dates.len() - 1].clone();
    let ending_prices = keys
        .iter()
        .map(|key| {
            prices_by_key[key]
                .get(&end_date)
                .copied()
                .with_context(|| format!("aligned ending price missing for {key}"))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok((
        AlignedReturns {
            start_date: dates[0].clone(),
            end_date,
            dates,
            portfolio_returns,
            keys,
            asset_returns,
            ending_prices,
            normalized_weights: active_weights,
        },
        warnings,
    ))
}

fn normalized_lot_sizes(
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
) -> Result<BTreeMap<String, f64>> {
    let mut normalized = BTreeMap::new();
    for key in &aligned.keys {
        let lot_size = input.lot_sizes.get(key).copied().unwrap_or(1.0);
        ensure!(
            lot_size.is_finite() && lot_size > 0.0,
            "lot size for {key} must be finite and positive"
        );
        normalized.insert(key.clone(), lot_size);
    }
    Ok(normalized)
}

fn floor_to_lot(quantity: f64, lot_size: f64) -> f64 {
    ((quantity / lot_size) + 1e-12).floor().max(0.0) * lot_size
}

fn target_quantity(amount: f64, price: f64, lot_size: f64, mode: QuantityMode) -> f64 {
    let raw = (amount / price).max(0.0);
    match mode {
        QuantityMode::Fractional => raw,
        QuantityMode::Whole => floor_to_lot(raw, lot_size),
    }
}

fn initialize_path(
    path_index: usize,
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    lot_sizes: &BTreeMap<String, f64>,
    regime_model: &RegimeModel,
) -> Result<PathState> {
    let cost_rate = input.transaction_cost_bps / 10_000.0;
    let gross_asset_budget = input.initial_amount * (1.0 - input.cash_weight);
    let asset_budget = gross_asset_budget / (1.0 + cost_rate);
    let mut quantities = Vec::with_capacity(aligned.keys.len());
    for (index, key) in aligned.keys.iter().enumerate() {
        quantities.push(target_quantity(
            asset_budget * aligned.normalized_weights[key],
            aligned.ending_prices[index],
            lot_sizes[key],
            input.quantity_mode,
        ));
    }
    let invested = quantities
        .iter()
        .zip(&aligned.ending_prices)
        .map(|(quantity, price)| quantity * price)
        .sum::<f64>();
    let initial_cost = invested * cost_rate;
    let cash = (input.initial_amount - invested - initial_cost).max(0.0);
    let opening_balance = cash + invested;
    ensure!(
        opening_balance.is_finite() && opening_balance >= 0.0,
        "initial allocation produced an invalid balance"
    );
    let regime = categorical_index(
        &regime_model.initial_probabilities,
        uniform_counter(input.seed, path_index as u64, 0),
    );
    Ok(PathState {
        quantities,
        prices: aligned.ending_prices.clone(),
        cash,
        peak: opening_balance,
        maximum_drawdown: 0.0,
        ever_depleted: opening_balance <= f64::EPSILON,
        sampled_index: 0,
        regime,
        contributions: 0.0,
        withdrawals: 0.0,
        cash_yield: 0.0,
        transaction_costs: initial_cost,
        turnover: if input.initial_amount > 0.0 {
            invested / input.initial_amount
        } else {
            0.0
        },
        rebalance_count: 0,
        maximum_conservation_error: 0.0,
    })
}

fn build_regime_model(returns: &[f64]) -> RegimeModel {
    let thresholds = percentile_values(returns, &[1.0 / 3.0, 2.0 / 3.0]);
    let classify = |value: f64| {
        if value <= thresholds[0] {
            0
        } else if value <= thresholds[1] {
            1
        } else {
            2
        }
    };
    let mut indices: [Vec<usize>; 3] = std::array::from_fn(|_| Vec::new());
    let assignments = returns
        .iter()
        .copied()
        .enumerate()
        .map(|(index, value)| {
            let regime = classify(value);
            indices[regime].push(index);
            regime
        })
        .collect::<Vec<_>>();
    let mut transition_counts = [[1.0_f64; 3]; 3];
    for pair in assignments.windows(2) {
        transition_counts[pair[0]][pair[1]] += 1.0;
    }
    let transition_probabilities = std::array::from_fn(|from| {
        let total = transition_counts[from].iter().sum::<f64>();
        std::array::from_fn(|to| transition_counts[from][to] / total)
    });
    let initial_probabilities =
        std::array::from_fn(|regime| indices[regime].len() as f64 / returns.len() as f64);
    RegimeModel {
        degenerate: indices.iter().any(Vec::is_empty),
        indices,
        transition_probabilities,
        initial_probabilities,
    }
}

fn build_student_t_model(asset_returns: &[Vec<f64>]) -> Result<StudentTModel> {
    let dimensions = asset_returns
        .first()
        .map(Vec::len)
        .context("aligned asset returns are empty")?;
    ensure!(dimensions > 0, "aligned asset returns have no assets");
    let count = asset_returns.len() as f64;
    let means = (0..dimensions)
        .map(|asset| asset_returns.iter().map(|row| row[asset]).sum::<f64>() / count)
        .collect::<Vec<_>>();
    let denominator = (asset_returns.len().saturating_sub(1)).max(1) as f64;
    let mut covariance = vec![vec![0.0; dimensions]; dimensions];
    for left in 0..dimensions {
        for right in 0..=left {
            let value = asset_returns
                .iter()
                .map(|row| (row[left] - means[left]) * (row[right] - means[right]))
                .sum::<f64>()
                / denominator;
            covariance[left][right] = value;
            covariance[right][left] = value;
        }
    }
    let maximum_variance = (0..dimensions)
        .map(|index| covariance[index][index])
        .max_by(f64::total_cmp)
        .unwrap_or(0.0)
        .max(0.0);
    let jitter = (maximum_variance * 1e-10).max(1e-12);
    for (index, row) in covariance.iter_mut().enumerate() {
        row[index] += jitter;
    }
    let cholesky = cholesky_lower(&covariance, jitter);
    Ok(StudentTModel { means, cholesky })
}

fn cholesky_lower(matrix: &[Vec<f64>], floor: f64) -> Vec<Vec<f64>> {
    let size = matrix.len();
    let mut lower = vec![vec![0.0; size]; size];
    for row in 0..size {
        for column in 0..=row {
            let product = (0..column)
                .map(|index| lower[row][index] * lower[column][index])
                .sum::<f64>();
            if row == column {
                lower[row][column] = (matrix[row][row] - product).max(floor).sqrt();
            } else {
                lower[row][column] = (matrix[row][column] - product) / lower[column][column];
            }
        }
    }
    lower
}

#[allow(clippy::too_many_arguments)]
fn sample_asset_returns<'a>(
    input: &MonteCarloInput,
    aligned: &'a AlignedReturns,
    regime_model: &RegimeModel,
    student_t_model: &StudentTModel,
    restart_probability: f64,
    state: &mut PathState,
    path_index: usize,
    step: usize,
) -> SampledAssetReturns<'a> {
    if input.method == SimulationMethod::StudentT {
        let normals = (0..aligned.keys.len())
            .map(|asset| {
                normal_counter(input.seed, path_index as u64, draw_counter(step, asset * 2))
            })
            .collect::<Vec<_>>();
        let chi_normal = normal_counter(
            input.seed,
            path_index as u64,
            draw_counter(step, aligned.keys.len() * 2 + 1),
        );
        let degrees = input.student_t_degrees_of_freedom;
        let chi_square = degrees
            * (1.0 - 2.0 / (9.0 * degrees) + chi_normal * (2.0 / (9.0 * degrees)).sqrt())
                .max(1e-6)
                .powi(3);
        let scale = ((degrees - 2.0) / chi_square.max(1e-12)).sqrt();
        return SampledAssetReturns::Parametric(
            (0..aligned.keys.len())
                .map(|asset| {
                    let correlated = (0..=asset)
                        .map(|factor| student_t_model.cholesky[asset][factor] * normals[factor])
                        .sum::<f64>();
                    (student_t_model.means[asset] + correlated * scale).max(-0.999_999)
                })
                .collect(),
        );
    }

    let observation_count = aligned.asset_returns.len();
    let sampled_index = match input.method {
        SimulationMethod::MovingBlock => {
            let block = step / input.block_length;
            let within_block = step % input.block_length;
            let starts = observation_count - input.block_length + 1;
            bounded_counter(input.seed, path_index as u64, block as u64, starts) + within_block
        }
        SimulationMethod::Stationary => {
            let restart = step == 0
                || uniform_counter(input.seed, path_index as u64, draw_counter(step, 0))
                    < restart_probability;
            if restart {
                state.sampled_index = bounded_counter(
                    input.seed,
                    path_index as u64,
                    draw_counter(step, 1),
                    observation_count,
                );
            } else {
                state.sampled_index = (state.sampled_index + 1) % observation_count;
            }
            state.sampled_index
        }
        SimulationMethod::RegimeConditioned => {
            let candidates = &regime_model.indices[state.regime];
            let index = if candidates.is_empty() {
                bounded_counter(
                    input.seed,
                    path_index as u64,
                    draw_counter(step, 2),
                    observation_count,
                )
            } else {
                candidates[bounded_counter(
                    input.seed,
                    path_index as u64,
                    draw_counter(step, 2),
                    candidates.len(),
                )]
            };
            state.regime = categorical_index(
                &regime_model.transition_probabilities[state.regime],
                uniform_counter(input.seed, path_index as u64, draw_counter(step, 3)),
            );
            index
        }
        SimulationMethod::StudentT => unreachable!(),
    };
    SampledAssetReturns::Historical(&aligned.asset_returns[sampled_index])
}

fn draw_counter(step: usize, channel: usize) -> u64 {
    (step as u64)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(channel as u64)
}

fn uniform_counter(seed: u64, path_index: u64, draw_index: u64) -> f64 {
    let bits = counter_random(seed, path_index, draw_index) >> 11;
    bits as f64 * (1.0 / ((1_u64 << 53) as f64))
}

fn normal_counter(seed: u64, path_index: u64, draw_index: u64) -> f64 {
    let first = uniform_counter(seed, path_index, draw_index).max(f64::MIN_POSITIVE);
    let second = uniform_counter(
        seed,
        path_index,
        draw_index.wrapping_add(0xA076_1D64_78BD_642F),
    );
    (-2.0 * first.ln()).sqrt() * (std::f64::consts::TAU * second).cos()
}

fn categorical_index<const N: usize>(probabilities: &[f64; N], draw: f64) -> usize {
    let mut cumulative = 0.0;
    for (index, probability) in probabilities.iter().enumerate() {
        cumulative += probability;
        if draw < cumulative {
            return index;
        }
    }
    N.saturating_sub(1)
}

fn annual_growth_factor(annual_percent: f64, days: usize) -> f64 {
    (1.0 + annual_percent / 100.0).powf(days as f64 / TRADING_DAYS_PER_YEAR)
}

fn is_cash_flow_adjusted_terminal_loss(
    terminal_balance: f64,
    initial_amount: f64,
    contributions: f64,
    withdrawals: f64,
) -> bool {
    let contributed_capital = initial_amount + contributions;
    let recovered_capital = terminal_balance + withdrawals;
    let tolerance = contributed_capital
        .abs()
        .max(recovered_capital.abs())
        .max(1.0)
        * 1e-9;
    recovered_capital + tolerance < contributed_capital
}

fn should_rebalance(
    state: &PathState,
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    step: usize,
) -> bool {
    match input.rebalance_frequency {
        RebalanceFrequency::None => false,
        RebalanceFrequency::Monthly => (step + 1).is_multiple_of(21),
        RebalanceFrequency::Quarterly => (step + 1).is_multiple_of(63),
        RebalanceFrequency::Annually => (step + 1).is_multiple_of(252),
        RebalanceFrequency::Threshold => {
            let total = state.balance();
            if total <= f64::EPSILON {
                return false;
            }
            let asset_deviation = state
                .quantities
                .iter()
                .zip(&state.prices)
                .zip(&aligned.keys)
                .map(|((quantity, price), key)| {
                    let actual = quantity * price / total;
                    let target = (1.0 - input.cash_weight) * aligned.normalized_weights[key];
                    (actual - target).abs()
                })
                .max_by(f64::total_cmp)
                .unwrap_or(0.0);
            let cash_deviation = (state.cash / total - input.cash_weight).abs();
            asset_deviation.max(cash_deviation) * 100.0
                >= input.rebalance_threshold_percent.unwrap_or(f64::INFINITY)
        }
    }
}

fn rebalance_path(
    state: &mut PathState,
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    lot_sizes: &BTreeMap<String, f64>,
) -> (f64, f64) {
    let total = state.balance();
    if total <= f64::EPSILON {
        return (0.0, 0.0);
    }
    let cost_rate = input.transaction_cost_bps / 10_000.0;
    let old_quantities = state.quantities.clone();
    let mut budget = total * (1.0 - input.cash_weight) / (1.0 + cost_rate);
    let mut target = old_quantities.clone();
    let mut trade_notional = 0.0;
    let mut cost = 0.0;
    let mut target_value = 0.0;
    for _ in 0..4 {
        target = aligned
            .keys
            .iter()
            .enumerate()
            .map(|(index, key)| {
                target_quantity(
                    budget * aligned.normalized_weights[key],
                    state.prices[index],
                    lot_sizes[key],
                    input.quantity_mode,
                )
            })
            .collect();
        target_value = target
            .iter()
            .zip(&state.prices)
            .map(|(quantity, price)| quantity * price)
            .sum();
        trade_notional = target
            .iter()
            .zip(&old_quantities)
            .zip(&state.prices)
            .map(|((next, previous), price)| (next - previous).abs() * price)
            .sum();
        cost = trade_notional * cost_rate;
        if target_value + cost <= total + 1e-9 {
            break;
        }
        budget *= (total / (target_value + cost)).clamp(0.0, 1.0) * 0.999_999;
    }
    if target_value + cost > total + 1e-7 {
        return (0.0, 0.0);
    }
    state.quantities = target;
    state.cash = (total - target_value - cost).max(0.0);
    state.transaction_costs += cost;
    let turnover = trade_notional / total;
    state.turnover += turnover;
    state.rebalance_count += 1;
    (cost, turnover)
}

fn allocate_contribution(
    state: &mut PathState,
    contribution: f64,
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    lot_sizes: &BTreeMap<String, f64>,
) -> f64 {
    if contribution <= 0.0 {
        return 0.0;
    }
    let cost_rate = input.transaction_cost_bps / 10_000.0;
    let asset_budget = contribution * (1.0 - input.cash_weight) / (1.0 + cost_rate);
    let mut trade_notional = 0.0;
    for (index, key) in aligned.keys.iter().enumerate() {
        let addition = target_quantity(
            asset_budget * aligned.normalized_weights[key],
            state.prices[index],
            lot_sizes[key],
            input.quantity_mode,
        );
        state.quantities[index] += addition;
        trade_notional += addition * state.prices[index];
    }
    let cost = trade_notional * cost_rate;
    state.cash = (state.cash - trade_notional - cost).max(0.0);
    state.transaction_costs += cost;
    let balance_before_cost = state.balance() + cost;
    if balance_before_cost > 0.0 {
        state.turnover += trade_notional / balance_before_cost;
    }
    cost
}

fn withdraw_from_path(
    state: &mut PathState,
    requested: f64,
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    lot_sizes: &BTreeMap<String, f64>,
) -> (f64, f64) {
    if requested <= 0.0 {
        return (0.0, 0.0);
    }
    let from_cash = state.cash.min(requested);
    state.cash -= from_cash;
    let mut withdrawn = from_cash;
    let need = requested - from_cash;
    if need <= 1e-9 {
        return (withdrawn, 0.0);
    }
    let asset_value = state
        .quantities
        .iter()
        .zip(&state.prices)
        .map(|(quantity, price)| quantity * price)
        .sum::<f64>();
    let cost_rate = input.transaction_cost_bps / 10_000.0;
    let net_available = asset_value * (1.0 - cost_rate);
    if need >= net_available - 1e-9 {
        let cost = asset_value * cost_rate;
        state.quantities.fill(0.0);
        withdrawn += net_available.max(0.0);
        state.ever_depleted = true;
        state.transaction_costs += cost;
        return (withdrawn, cost);
    }

    let gross_sale = need / (1.0 - cost_rate);
    let target_asset_value = (asset_value - gross_sale).max(0.0);
    let ratio = if asset_value > 0.0 {
        target_asset_value / asset_value
    } else {
        0.0
    };
    let previous = state.quantities.clone();
    for (index, quantity) in state.quantities.iter_mut().enumerate() {
        let raw = previous[index] * ratio;
        *quantity = match input.quantity_mode {
            QuantityMode::Fractional => raw,
            QuantityMode::Whole => floor_to_lot(raw, lot_sizes[&aligned.keys[index]]),
        };
    }
    let sold = previous
        .iter()
        .zip(&state.quantities)
        .zip(&state.prices)
        .map(|((old, new), price)| (old - new).max(0.0) * price)
        .sum::<f64>();
    let cost = sold * cost_rate;
    let net = (sold - cost).max(0.0);
    let applied = need.min(net);
    withdrawn += applied;
    state.cash += net - applied;
    state.transaction_costs += cost;
    (withdrawn, cost)
}

fn advance_path(
    state: &mut PathState,
    sampled_returns: &[f64],
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    lot_sizes: &BTreeMap<String, f64>,
    step: usize,
) {
    let opening_balance = state.balance();
    let opening_asset_value = state
        .quantities
        .iter()
        .zip(&state.prices)
        .map(|(quantity, price)| quantity * price)
        .sum::<f64>();
    for (price, daily_return) in state.prices.iter_mut().zip(sampled_returns) {
        *price *= 1.0 + daily_return.max(-0.999_999);
    }
    let closing_asset_value = state
        .quantities
        .iter()
        .zip(&state.prices)
        .map(|(quantity, price)| quantity * price)
        .sum::<f64>();
    let asset_profit = closing_asset_value - opening_asset_value;
    let cash_before_yield = state.cash;
    state.cash *= annual_growth_factor(input.cash_annual_yield_percent, 1);
    let cash_yield = state.cash - cash_before_yield;
    state.cash_yield += cash_yield;

    let mut contribution = 0.0;
    let mut withdrawal = 0.0;
    let mut step_cost = 0.0;
    if input.periodic_cash_flow != 0.0 && (step + 1).is_multiple_of(input.cash_flow_frequency_days)
    {
        let indexed_flow = input.periodic_cash_flow
            * annual_growth_factor(input.inflation_annual_percent, step + 1);
        if indexed_flow > 0.0 {
            state.cash += indexed_flow;
            state.contributions += indexed_flow;
            contribution = indexed_flow;
            step_cost += allocate_contribution(state, indexed_flow, input, aligned, lot_sizes);
        } else {
            let (applied, cost) =
                withdraw_from_path(state, -indexed_flow, input, aligned, lot_sizes);
            state.withdrawals += applied;
            withdrawal = applied;
            step_cost += cost;
        }
    }
    if should_rebalance(state, input, aligned, step) {
        let (cost, _) = rebalance_path(state, input, aligned, lot_sizes);
        step_cost += cost;
    }

    let balance = state.balance().max(0.0);
    let expected =
        opening_balance + asset_profit + cash_yield + contribution - withdrawal - step_cost;
    state.maximum_conservation_error = state
        .maximum_conservation_error
        .max((balance - expected).abs());
    if balance <= f64::EPSILON {
        state.ever_depleted = true;
    }
    if balance > state.peak {
        state.peak = balance;
    }
    let drawdown = if state.peak > 0.0 {
        (1.0 - balance / state.peak).clamp(0.0, 1.0)
    } else {
        0.0
    };
    state.maximum_drawdown = state.maximum_drawdown.max(drawdown);
}

fn unavailable_calibration(requested_origins: usize, status: &'static str) -> CalibrationSummary {
    CalibrationSummary {
        status,
        requested_origins,
        evaluated_origins: 0,
        path_count_per_origin: 0,
        lower_quantile: None,
        upper_quantile: None,
        coverage_percent: None,
        coverage_score: None,
        bias_percent: None,
        observations: Vec::new(),
    }
}

fn compound_return(returns: &[f64]) -> f64 {
    returns
        .iter()
        .fold(1.0, |growth, daily_return| growth * (1.0 + daily_return))
        - 1.0
}

fn scalar_student_parameters(returns: &[f64]) -> (f64, f64) {
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let variance = if returns.len() > 1 {
        returns
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / (returns.len() - 1) as f64
    } else {
        0.0
    };
    (mean, variance.max(1e-12).sqrt())
}

#[allow(clippy::too_many_arguments)]
fn calibrated_path_return(
    training: &[f64],
    regime_model: &RegimeModel,
    student_mean: f64,
    student_standard_deviation: f64,
    method: SimulationMethod,
    block_length: usize,
    restart_probability: f64,
    degrees_of_freedom: f64,
    seed: u64,
    path_index: usize,
    horizon: usize,
) -> f64 {
    let mut sampled_index = 0;
    let mut regime = categorical_index(
        &regime_model.initial_probabilities,
        uniform_counter(seed, path_index as u64, 0),
    );
    let mut growth = 1.0;
    for step in 0..horizon {
        let daily_return = match method {
            SimulationMethod::MovingBlock => {
                let block = step / block_length;
                let within = step % block_length;
                let starts = training.len() - block_length + 1;
                let start = bounded_counter(seed, path_index as u64, block as u64, starts);
                training[start + within]
            }
            SimulationMethod::Stationary => {
                let restart = step == 0
                    || uniform_counter(seed, path_index as u64, draw_counter(step, 0))
                        < restart_probability;
                if restart {
                    sampled_index = bounded_counter(
                        seed,
                        path_index as u64,
                        draw_counter(step, 1),
                        training.len(),
                    );
                } else {
                    sampled_index = (sampled_index + 1) % training.len();
                }
                training[sampled_index]
            }
            SimulationMethod::RegimeConditioned => {
                let candidates = &regime_model.indices[regime];
                let index = if candidates.is_empty() {
                    bounded_counter(
                        seed,
                        path_index as u64,
                        draw_counter(step, 2),
                        training.len(),
                    )
                } else {
                    candidates[bounded_counter(
                        seed,
                        path_index as u64,
                        draw_counter(step, 2),
                        candidates.len(),
                    )]
                };
                regime = categorical_index(
                    &regime_model.transition_probabilities[regime],
                    uniform_counter(seed, path_index as u64, draw_counter(step, 3)),
                );
                training[index]
            }
            SimulationMethod::StudentT => {
                let normal = normal_counter(seed, path_index as u64, draw_counter(step, 4));
                let chi_normal = normal_counter(seed, path_index as u64, draw_counter(step, 5));
                let chi_square = degrees_of_freedom
                    * (1.0 - 2.0 / (9.0 * degrees_of_freedom)
                        + chi_normal * (2.0 / (9.0 * degrees_of_freedom)).sqrt())
                    .max(1e-6)
                    .powi(3);
                (student_mean
                    + student_standard_deviation
                        * normal
                        * ((degrees_of_freedom - 2.0) / chi_square.max(1e-12)).sqrt())
                .max(-0.999_999)
            }
        };
        growth *= 1.0 + daily_return;
    }
    growth - 1.0
}

fn calibrate_history(
    input: &MonteCarloInput,
    aligned: &AlignedReturns,
    quantiles: &[f64],
    warnings: &mut Vec<String>,
) -> Result<CalibrationSummary> {
    if input.calibration_origins == 0 {
        return Ok(unavailable_calibration(0, "not_requested"));
    }
    let observation_count = aligned.portfolio_returns.len();
    let minimum_training = (input.block_length * 2).max(20);
    if observation_count <= minimum_training + 1 {
        warnings.push(format!(
            "historical Monte Carlo calibration is unavailable: {observation_count} observations are insufficient for {minimum_training} training observations"
        ));
        return Ok(unavailable_calibration(
            input.calibration_origins,
            "unavailable",
        ));
    }
    let maximum_horizon = observation_count - minimum_training;
    let horizon = input
        .horizon_days
        .min(MAX_CALIBRATION_HORIZON_DAYS)
        .min(maximum_horizon)
        .max(1);
    let eligible_count = observation_count - horizon - minimum_training + 1;
    if eligible_count == 0 {
        warnings.push(
            "historical Monte Carlo calibration is unavailable: no leakage-free origin has a complete realized horizon"
                .into(),
        );
        return Ok(unavailable_calibration(
            input.calibration_origins,
            "unavailable",
        ));
    }
    let evaluated_count = input.calibration_origins.min(eligible_count);
    if evaluated_count < input.calibration_origins {
        warnings.push(format!(
            "historical Monte Carlo calibration evaluated {evaluated_count} of {} requested origins because complete historical horizons were unavailable",
            input.calibration_origins
        ));
    }
    warnings.push(
        "historical Monte Carlo calibration validates the return generator only; future cash flows, execution costs, and quantity rounding have no historical ground truth"
            .into(),
    );
    let path_count = input.path_count.min(1_000);
    let lower_quantile = quantiles[0];
    let upper_quantile = quantiles[quantiles.len() - 1];
    let restart_probability = input
        .stationary_restart_probability
        .unwrap_or(1.0 / input.block_length as f64);
    let mut observations = Vec::with_capacity(evaluated_count);
    let mut previous_origin = None;
    for sample in 0..evaluated_count {
        let offset = ((sample + 1) * (eligible_count + 1) / (evaluated_count + 1))
            .saturating_sub(1)
            .min(eligible_count - 1);
        let origin = minimum_training + offset;
        if previous_origin == Some(origin) {
            continue;
        }
        previous_origin = Some(origin);
        let training = &aligned.portfolio_returns[..origin];
        let realized = compound_return(&aligned.portfolio_returns[origin..origin + horizon]);
        let regime_model = build_regime_model(training);
        let (student_mean, student_standard_deviation) = scalar_student_parameters(training);
        let calibration_seed = mix64(input.seed ^ origin as u64 ^ 0xCA11_BA7E_D15C_A11B);
        let simulated = (0..path_count)
            .map(|path_index| {
                calibrated_path_return(
                    training,
                    &regime_model,
                    student_mean,
                    student_standard_deviation,
                    input.method,
                    input.block_length,
                    restart_probability,
                    input.student_t_degrees_of_freedom,
                    calibration_seed,
                    path_index,
                    horizon,
                )
            })
            .collect::<Vec<_>>();
        let predicted = percentile_values(&simulated, &[lower_quantile, 0.5, upper_quantile]);
        let covered = realized >= predicted[0] && realized <= predicted[2];
        observations.push(CalibrationObservation {
            origin_date: aligned.dates[origin - 1].clone(),
            target_date: aligned.dates[origin + horizon - 1].clone(),
            horizon_days: horizon,
            actual_return_percent: realized * 100.0,
            predicted_median_return_percent: predicted[1] * 100.0,
            lower_return_percent: predicted[0] * 100.0,
            upper_return_percent: predicted[2] * 100.0,
            covered,
            bias_percent: (predicted[1] - realized) * 100.0,
        });
    }
    let evaluated_origins = observations.len();
    ensure!(evaluated_origins > 0, "calibration origin selection failed");
    let coverage_percent = observations.iter().filter(|item| item.covered).count() as f64
        / evaluated_origins as f64
        * 100.0;
    let bias_percent = observations
        .iter()
        .map(|item| item.bias_percent)
        .sum::<f64>()
        / evaluated_origins as f64;
    Ok(CalibrationSummary {
        status: "available",
        requested_origins: input.calibration_origins,
        evaluated_origins,
        path_count_per_origin: path_count,
        lower_quantile: Some(lower_quantile),
        upper_quantile: Some(upper_quantile),
        coverage_percent: Some(coverage_percent),
        coverage_score: Some(coverage_percent / 100.0),
        bias_percent: Some(bias_percent),
        observations,
    })
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

    fn calibration_input() -> Value {
        let first = (0..80)
            .map(|index| {
                json!({
                    "date": crate::date::add_days("2023-01-01", index).unwrap(),
                    "value": 100.0 * (1.0_f64 + 0.0008 + (index as f64 * 0.31).sin() * 0.012).powi(index as i32),
                })
            })
            .collect::<Vec<_>>();
        let second = (0..80)
            .map(|index| {
                json!({
                    "date": crate::date::add_days("2023-01-01", index).unwrap(),
                    "value": 80.0 * (1.0_f64 + 0.0004 + (index as f64 * 0.23 + 1.0).cos() * 0.009).powi(index as i32),
                })
            })
            .collect::<Vec<_>>();
        json!({
            "priceSeries": [
                { "key": "A", "points": first },
                { "key": "B", "points": second }
            ],
            "weights": { "A": 0.55, "B": 0.45 },
            "initialAmount": 10000.0,
            "horizonDays": 12,
            "pathCount": 100,
            "blockLength": 5,
            "seed": 991_u64,
            "quantiles": [0.1, 0.5, 0.9],
            "samplePathCount": 1,
            "calibrationOrigins": 3
        })
    }

    #[test]
    fn zero_returns_keep_every_path_flat() {
        let output = simulate(&flat_input()).unwrap();
        assert_eq!(output["distributions"]["terminalBalance"]["mean"], 1000.0);
        assert_eq!(output["distributions"]["totalReturnPercent"]["mean"], 0.0);
        assert_eq!(
            output["distributions"]["cashFlowAdjustedTerminalReturnPercent"]["mean"],
            0.0
        );
        assert_eq!(output["distributions"]["cagrPercent"]["mean"], 0.0);
        assert_eq!(output["distributions"]["maxDrawdownPercent"]["max"], 0.0);
        assert_eq!(
            output["probabilities"]["terminalLossProbabilityPercent"],
            0.0
        );
        assert_eq!(
            output["probabilities"]["terminalBalanceBelowInitialProbabilityPercent"],
            0.0
        );
        assert_eq!(
            output["probabilities"]["terminalLossBasis"],
            "terminal_balance_plus_withdrawals_below_initial_capital_plus_contributions"
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
    fn every_return_generator_is_seed_reproducible() {
        for (method, label) in [
            ("moving_block", "correlated_moving_block_bootstrap"),
            ("stationary", "correlated_stationary_bootstrap"),
            (
                "regime_conditioned",
                "correlated_regime_conditioned_bootstrap",
            ),
            ("student_t", "fitted_multivariate_student_t"),
        ] {
            let mut input = variable_input();
            input["method"] = json!(method);
            let first = simulate(&input).unwrap();
            let second = simulate(&input).unwrap();
            assert_eq!(first, second, "method={method}");
            assert_eq!(first["method"], label);
            assert!(
                first["distributions"]["terminalBalance"]["mean"]
                    .as_f64()
                    .unwrap()
                    .is_finite()
            );
        }
    }

    #[test]
    fn cash_yield_flows_costs_and_lots_preserve_the_ledger() {
        let mut input = flat_input();
        input["horizonDays"] = json!(252);
        input["cashWeight"] = json!(0.5);
        input["cashAnnualYieldPercent"] = json!(10.0);
        input["periodicCashFlow"] = json!(100.0);
        input["cashFlowFrequencyDays"] = json!(21);
        input["transactionCostBps"] = json!(25.0);
        input["rebalanceFrequency"] = json!("monthly");
        input["quantityMode"] = json!("whole");
        input["lotSizes"] = json!({ "A": 4.0, "B": 3.0 });
        let output = simulate(&input).unwrap();

        assert_eq!(output["ledger"]["contributions"]["mean"], 1200.0);
        assert!(output["ledger"]["cashYield"]["mean"].as_f64().unwrap() > 0.0);
        assert!(
            output["ledger"]["transactionCosts"]["mean"]
                .as_f64()
                .unwrap()
                > 0.0
        );
        assert!(
            output["ledger"]["maximumConservationError"]
                .as_f64()
                .unwrap()
                < 1e-7
        );
        assert_eq!(output["ledger"]["quantityMode"], "whole");
    }

    #[test]
    fn withdrawals_report_ever_depleted_probability() {
        let mut input = flat_input();
        input["periodicCashFlow"] = json!(-600.0);
        input["cashFlowFrequencyDays"] = json!(2);
        let output = simulate(&input).unwrap();
        assert_eq!(
            output["probabilities"]["everDepletedProbabilityPercent"],
            100.0
        );
        assert_eq!(output["distributions"]["terminalBalance"]["mean"], 0.0);
        assert_eq!(output["ledger"]["withdrawals"]["mean"], 1000.0);
        assert_eq!(
            output["probabilities"]["terminalBalanceBelowInitialProbabilityPercent"],
            100.0
        );
        assert_eq!(
            output["probabilities"]["terminalLossProbabilityPercent"],
            0.0
        );
        assert_eq!(
            output["distributions"]["cashFlowAdjustedTerminalReturnPercent"]["mean"],
            0.0
        );
        assert!(
            output["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning.as_str().unwrap().contains(
                    "cashFlowAdjustedTerminalReturnPercent uses terminal balance plus withdrawals"
                ))
        );
    }

    #[test]
    fn cash_flow_adjusted_loss_comparison_has_a_scale_aware_tolerance() {
        assert!(!is_cash_flow_adjusted_terminal_loss(
            500.0, 1_000.0, 0.0, 500.0
        ));
        assert!(!is_cash_flow_adjusted_terminal_loss(
            1_500.0, 1_000.0, 500.0, 0.0
        ));
        assert!(is_cash_flow_adjusted_terminal_loss(
            499.0, 1_000.0, 0.0, 500.0
        ));
        assert!(!is_cash_flow_adjusted_terminal_loss(
            999_999_999.5,
            1_000_000_000.0,
            0.0,
            0.0
        ));
    }

    #[test]
    fn contributions_are_invested_without_rebalancing_existing_holdings() {
        let mut input = flat_input();
        input["cashWeight"] = json!(0.2);
        input["periodicCashFlow"] = json!(100.0);
        input["cashFlowFrequencyDays"] = json!(2);
        input["rebalanceFrequency"] = json!("none");
        let output = simulate(&input).unwrap();
        assert_eq!(output["ledger"]["contributions"]["mean"], 500.0);
        assert!((output["ledger"]["terminalCash"]["mean"].as_f64().unwrap() - 300.0).abs() < 1e-9);
        assert!(
            (output["ledger"]["terminalInvested"]["mean"]
                .as_f64()
                .unwrap()
                - 1200.0)
                .abs()
                < 1e-9
        );
        assert!(
            output["ledger"]["maximumConservationError"]
                .as_f64()
                .unwrap()
                < 1e-9
        );
    }

    #[test]
    fn historical_calibration_reports_coverage_bias_or_an_explicit_warning() {
        let available = simulate(&calibration_input()).unwrap();
        assert_eq!(available["calibration"]["status"], "available");
        assert_eq!(available["calibration"]["evaluatedOrigins"], 3);
        assert!(
            (0.0..=100.0).contains(
                &available["calibration"]["coveragePercent"]
                    .as_f64()
                    .unwrap()
            )
        );
        assert!(
            available["calibration"]["biasPercent"]
                .as_f64()
                .unwrap()
                .is_finite()
        );

        let mut unavailable = flat_input();
        unavailable["calibrationOrigins"] = json!(2);
        let unavailable = simulate(&unavailable).unwrap();
        assert_eq!(unavailable["calibration"]["status"], "unavailable");
        assert!(
            unavailable["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning.as_str().unwrap().contains("unavailable"))
        );
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
