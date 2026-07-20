use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::backtest;
use crate::control::{ComputeControl, checkpoint};
use crate::date::parse_iso_date;
use crate::indicators::{
    IndicatorKind, PointState, ResponseMode, TechnicalAnalysisRequest, TechnicalAnalysisResult,
    analyze as analyze_technical_indicators, catalog_entry,
};
use crate::model::{BacktestSimulationInput, BacktestSimulationResult, TargetWeightScheduleEntry};

pub const TECHNICAL_STRATEGY_SCHEMA_VERSION: &str = "technical-strategy/v1";
pub const TECHNICAL_STRATEGY_RESULT_SCHEMA_VERSION: &str = "technical-strategy-result/v1";

const MAX_CONDITION_DEPTH: usize = 16;
const MAX_CONDITION_NODES: usize = 256;
const MAX_HOLDING_OR_COOLDOWN: usize = 10_000;
const MAX_SIGNALS: usize = 10_000;
const WEIGHT_TOLERANCE: f64 = 0.01;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum StrategyState {
    Active,
    Inactive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum BarField {
    Open,
    High,
    Low,
    Close,
    Volume,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operand {
    Indicator {
        instrument_key: String,
        indicator_id: String,
        field: String,
    },
    Bar {
        instrument_key: String,
        field: BarField,
    },
    Constant {
        value: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "operator", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConditionNode {
    GreaterThan {
        left: Operand,
        right: Operand,
    },
    LessThan {
        left: Operand,
        right: Operand,
    },
    CrossesAbove {
        left: Operand,
        right: Operand,
    },
    CrossesBelow {
        left: Operand,
        right: Operand,
    },
    Between {
        value: Operand,
        lower: Operand,
        upper: Operand,
    },
    All {
        conditions: Vec<ConditionNode>,
    },
    Any {
        conditions: Vec<ConditionNode>,
    },
    Not {
        condition: Box<ConditionNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StrategyAllocation {
    pub weights: BTreeMap<String, f64>,
    pub cash_target_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StrategyAllocations {
    pub active: StrategyAllocation,
    pub inactive: StrategyAllocation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TechnicalStrategyDefinition {
    pub schema_version: String,
    pub initial_state: StrategyState,
    pub active_when: ConditionNode,
    pub inactive_when: ConditionNode,
    pub minimum_holding_period: usize,
    pub cooldown_period: usize,
    pub allocations: StrategyAllocations,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignalTransition {
    Activate,
    Deactivate,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TechnicalSignalStatus {
    Planned,
    Applied,
    NoSafeTradeDate,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TechnicalSignal {
    pub signal_id: String,
    pub transition: SignalTransition,
    pub calculation_date: String,
    pub signal_date: String,
    pub planned_trade_date: Option<String>,
    pub actual_application_date: Option<String>,
    pub from_state: StrategyState,
    pub to_state: StrategyState,
    pub target_weights: BTreeMap<String, f64>,
    pub cash_target_percent: f64,
    pub status: TechnicalSignalStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TechnicalStrategyDiagnostics {
    pub validation: String,
    pub condition_value_policy: String,
    pub between_policy: String,
    pub crossing_policy: String,
    pub signal_timing_policy: String,
    pub safe_trade_date_source: String,
    pub evaluation_start_date: String,
    pub evaluation_end_date: String,
    pub safe_trade_date_count: usize,
    pub condition_node_count: usize,
    pub active_unknown_count: usize,
    pub inactive_unknown_count: usize,
    pub minimum_holding_suppressed_count: usize,
    pub cooldown_suppressed_count: usize,
    pub pending_suppressed_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TechnicalStrategyEvaluation {
    pub schema_version: String,
    pub strategy_schema_version: String,
    pub initial_state: StrategyState,
    pub signals: Vec<TechnicalSignal>,
    pub target_weight_schedule: Vec<TargetWeightScheduleEntry>,
    pub diagnostics: TechnicalStrategyDiagnostics,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TechnicalStrategyRunResult {
    pub technical_analysis: TechnicalAnalysisResult,
    pub technical_strategy: TechnicalStrategyEvaluation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backtest: Option<BacktestSimulationResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TruthValue {
    True,
    False,
    Unknown,
}

#[derive(Debug, Clone)]
struct CrossObservation {
    left: f64,
    right: f64,
}

type IndicatorSeriesKey = (String, String, String);
type BarSeriesKey = (String, BarField);

#[derive(Default)]
struct ReferencedSeries {
    indicators: BTreeSet<IndicatorSeriesKey>,
    bars: BTreeSet<BarSeriesKey>,
}

#[derive(Default)]
struct EvaluationData {
    indicators: BTreeMap<IndicatorSeriesKey, BTreeMap<String, f64>>,
    bars: BTreeMap<BarSeriesKey, BTreeMap<String, f64>>,
}

impl EvaluationData {
    fn resolve(&self, operand: &Operand, date: &str) -> Option<f64> {
        match operand {
            Operand::Indicator {
                instrument_key,
                indicator_id,
                field,
            } => self
                .indicators
                .get(&(instrument_key.clone(), indicator_id.clone(), field.clone()))
                .and_then(|series| series.get(date))
                .copied(),
            Operand::Bar {
                instrument_key,
                field,
            } => self
                .bars
                .get(&(instrument_key.clone(), *field))
                .and_then(|series| series.get(date))
                .copied(),
            Operand::Constant { value } => Some(*value),
        }
    }
}

fn inspect_operand(operand: &Operand, references: &mut ReferencedSeries) -> Result<()> {
    match operand {
        Operand::Indicator {
            instrument_key,
            indicator_id,
            field,
        } => {
            ensure!(
                !instrument_key.is_empty(),
                "indicator instrument_key is required"
            );
            ensure!(
                !indicator_id.is_empty(),
                "indicator indicator_id is required"
            );
            ensure!(!field.is_empty(), "indicator field is required");
            ensure!(
                instrument_key.len() <= 128 && indicator_id.len() <= 128 && field.len() <= 64,
                "condition indicator reference exceeds its length limit"
            );
            references.indicators.insert((
                instrument_key.clone(),
                indicator_id.clone(),
                field.clone(),
            ));
        }
        Operand::Bar {
            instrument_key,
            field,
        } => {
            ensure!(!instrument_key.is_empty(), "bar instrument_key is required");
            ensure!(
                instrument_key.len() <= 128,
                "condition bar reference exceeds its length limit"
            );
            references.bars.insert((instrument_key.clone(), *field));
        }
        Operand::Constant { value } => {
            ensure!(value.is_finite(), "condition constants must be finite");
        }
    }
    Ok(())
}

fn inspect_condition(
    condition: &ConditionNode,
    depth: usize,
    node_count: &mut usize,
    references: &mut ReferencedSeries,
) -> Result<()> {
    ensure!(
        depth <= MAX_CONDITION_DEPTH,
        "condition tree depth exceeds {MAX_CONDITION_DEPTH}"
    );
    *node_count += 1;
    ensure!(
        *node_count <= MAX_CONDITION_NODES,
        "condition tree node count exceeds {MAX_CONDITION_NODES}"
    );
    match condition {
        ConditionNode::GreaterThan { left, right }
        | ConditionNode::LessThan { left, right }
        | ConditionNode::CrossesAbove { left, right }
        | ConditionNode::CrossesBelow { left, right } => {
            inspect_operand(left, references)?;
            inspect_operand(right, references)?;
        }
        ConditionNode::Between {
            value,
            lower,
            upper,
        } => {
            inspect_operand(value, references)?;
            inspect_operand(lower, references)?;
            inspect_operand(upper, references)?;
            if let (Operand::Constant { value: lower }, Operand::Constant { value: upper }) =
                (lower, upper)
            {
                ensure!(
                    lower <= upper,
                    "between lower constant must not exceed upper"
                );
            }
        }
        ConditionNode::All { conditions } | ConditionNode::Any { conditions } => {
            ensure!(
                !conditions.is_empty(),
                "all and any conditions must not be empty"
            );
            for condition in conditions {
                inspect_condition(condition, depth + 1, node_count, references)?;
            }
        }
        ConditionNode::Not { condition } => {
            inspect_condition(condition, depth + 1, node_count, references)?;
        }
    }
    Ok(())
}

fn validate_allocation(allocation: &StrategyAllocation, expected: &BTreeSet<String>) -> Result<()> {
    let actual = allocation.weights.keys().cloned().collect::<BTreeSet<_>>();
    ensure!(
        actual == *expected,
        "strategy allocations must contain every asset symbol exactly once"
    );
    ensure!(
        allocation.cash_target_percent.is_finite()
            && (0.0..=100.0).contains(&allocation.cash_target_percent),
        "strategy cash_target_percent must be between 0 and 100"
    );
    ensure!(
        allocation
            .weights
            .values()
            .all(|weight| weight.is_finite() && (0.0..=100.0).contains(weight)),
        "strategy weights must be finite percentages between 0 and 100"
    );
    let total = allocation.weights.values().sum::<f64>() + allocation.cash_target_percent;
    ensure!(
        (total - 100.0).abs() <= WEIGHT_TOLERANCE,
        "strategy allocation weights and cash must sum to 100"
    );
    Ok(())
}

fn validate_strategy(
    request: &TechnicalAnalysisRequest,
    strategy: &TechnicalStrategyDefinition,
    simulation: Option<&BacktestSimulationInput>,
) -> Result<(ReferencedSeries, usize)> {
    ensure!(
        strategy.schema_version == TECHNICAL_STRATEGY_SCHEMA_VERSION,
        "unsupported technical strategy schema version: {}",
        strategy.schema_version
    );
    ensure!(
        strategy.minimum_holding_period <= MAX_HOLDING_OR_COOLDOWN
            && strategy.cooldown_period <= MAX_HOLDING_OR_COOLDOWN,
        "minimum_holding_period and cooldown_period must not exceed {MAX_HOLDING_OR_COOLDOWN}"
    );
    let mut references = ReferencedSeries::default();
    let mut node_count = 0;
    inspect_condition(&strategy.active_when, 1, &mut node_count, &mut references)?;
    inspect_condition(&strategy.inactive_when, 1, &mut node_count, &mut references)?;

    let active_symbols = strategy
        .allocations
        .active
        .weights
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let inactive_symbols = strategy
        .allocations
        .inactive
        .weights
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    ensure!(
        !active_symbols.is_empty() && active_symbols == inactive_symbols,
        "active and inactive allocations must use the same non-empty asset universe"
    );
    let technical_symbols = request
        .instruments
        .iter()
        .map(|instrument| instrument.symbol.clone())
        .collect::<BTreeSet<_>>();
    ensure!(
        active_symbols.is_subset(&technical_symbols),
        "strategy allocation symbols must be present in technical_analysis instruments"
    );
    if let Some(simulation) = simulation {
        ensure!(
            simulation.target_weight_schedule.is_empty(),
            "technical strategy simulation must not contain a supplied targetWeightSchedule"
        );
        let simulation_symbols = simulation
            .assets
            .iter()
            .map(|asset| asset.symbol.clone())
            .collect::<BTreeSet<_>>();
        ensure!(
            simulation_symbols.len() == simulation.assets.len(),
            "technical strategy simulation asset symbols must be unique"
        );
        ensure!(
            active_symbols == simulation_symbols,
            "strategy allocations must exactly match the simulation asset symbols"
        );
        for asset in &simulation.assets {
            let matches = request
                .instruments
                .iter()
                .filter(|instrument| instrument.symbol == asset.symbol)
                .collect::<Vec<_>>();
            ensure!(
                matches.len() == 1,
                "each simulation asset must match exactly one technical instrument by symbol"
            );
            let instrument = matches[0];
            ensure!(
                instrument.currency == asset.currency || instrument.currency == "KRW",
                "technical instrument currency must match the asset currency or the KRW backtest conversion mode"
            );
            let price_key = format!("{}:{}", asset.currency, asset.symbol);
            let ledger_prices = simulation
                .prices
                .get(&price_key)
                .with_context(|| format!("simulation prices are missing {price_key}"))?;
            let comparable_close_by_date = ledger_prices
                .iter()
                .map(|point| {
                    (
                        point.date.as_str(),
                        if instrument.currency == asset.currency {
                            point.local_close.unwrap_or(point.close)
                        } else {
                            point.close
                        },
                    )
                })
                .collect::<BTreeMap<_, _>>();
            for bar in &instrument.bars {
                let Some(ledger_close) = comparable_close_by_date.get(bar.date.as_str()) else {
                    continue;
                };
                let tolerance = ledger_close.abs().max(bar.close.abs()).max(1.0) * 1e-8;
                ensure!(
                    (bar.close - ledger_close).abs() <= tolerance,
                    "technical and simulation close values disagree for {} on {}",
                    asset.symbol,
                    bar.date
                );
            }
        }
    }
    validate_allocation(&strategy.allocations.active, &active_symbols)?;
    validate_allocation(&strategy.allocations.inactive, &active_symbols)?;
    Ok((references, node_count))
}

fn validate_dates(dates: &[String]) -> Result<()> {
    ensure!(!dates.is_empty(), "safe_trade_dates must not be empty");
    let mut previous: Option<&str> = None;
    for date in dates {
        parse_iso_date(date)?;
        if let Some(previous) = previous {
            ensure!(
                previous < date.as_str(),
                "safe_trade_dates must be strictly ascending and unique"
            );
        }
        previous = Some(date);
    }
    Ok(())
}

fn evaluation_data(
    request: &TechnicalAnalysisRequest,
    technical: &TechnicalAnalysisResult,
    references: &ReferencedSeries,
) -> Result<EvaluationData> {
    let mut output = EvaluationData::default();
    for (instrument_key, indicator_id, field) in &references.indicators {
        let calculation = technical
            .calculations
            .iter()
            .find(|calculation| {
                calculation.instrument_key == *instrument_key
                    && calculation.indicator_id == *indicator_id
            })
            .with_context(|| {
                format!("condition references unknown indicator {instrument_key}/{indicator_id}")
            })?;
        ensure!(
            calculation.kind != IndicatorKind::VolumeProfile,
            "volume_profile cannot be referenced by a technical strategy condition"
        );
        ensure!(
            catalog_entry(calculation.kind)
                .output_fields
                .iter()
                .any(|candidate| candidate == field),
            "condition references unknown indicator output field {field}"
        );
        let points = calculation
            .points
            .as_ref()
            .context("technical strategy requires full-series indicator points")?;
        let series = points
            .iter()
            .filter_map(|point| {
                (point.state == PointState::Available)
                    .then(|| {
                        point
                            .values
                            .get(field)
                            .and_then(|value| *value)
                            .map(|value| (point.date.clone(), value))
                    })
                    .flatten()
            })
            .collect::<BTreeMap<_, _>>();
        output.indicators.insert(
            (instrument_key.clone(), indicator_id.clone(), field.clone()),
            series,
        );
    }
    for (instrument_key, field) in &references.bars {
        let instrument = request
            .instruments
            .iter()
            .find(|instrument| instrument.key == *instrument_key)
            .with_context(|| {
                format!("condition references unknown bar instrument {instrument_key}")
            })?;
        let series = instrument
            .bars
            .iter()
            .filter_map(|bar| {
                let value = match field {
                    BarField::Open => Some(bar.open),
                    BarField::High => Some(bar.high),
                    BarField::Low => Some(bar.low),
                    BarField::Close => Some(bar.close),
                    BarField::Volume => bar.volume,
                };
                value.map(|value| (bar.date.clone(), value))
            })
            .collect::<BTreeMap<_, _>>();
        output.bars.insert((instrument_key.clone(), *field), series);
    }
    Ok(output)
}

fn evaluate_condition(
    condition: &ConditionNode,
    date: &str,
    data: &EvaluationData,
    cross_history: &mut BTreeMap<usize, CrossObservation>,
    ordinal: &mut usize,
) -> TruthValue {
    let node_id = *ordinal;
    *ordinal += 1;
    match condition {
        ConditionNode::GreaterThan { left, right } => {
            match (data.resolve(left, date), data.resolve(right, date)) {
                (Some(left), Some(right)) if left > right => TruthValue::True,
                (Some(_), Some(_)) => TruthValue::False,
                _ => TruthValue::Unknown,
            }
        }
        ConditionNode::LessThan { left, right } => {
            match (data.resolve(left, date), data.resolve(right, date)) {
                (Some(left), Some(right)) if left < right => TruthValue::True,
                (Some(_), Some(_)) => TruthValue::False,
                _ => TruthValue::Unknown,
            }
        }
        ConditionNode::CrossesAbove { left, right }
        | ConditionNode::CrossesBelow { left, right } => {
            let (Some(left), Some(right)) = (data.resolve(left, date), data.resolve(right, date))
            else {
                return TruthValue::Unknown;
            };
            let prior = cross_history.insert(node_id, CrossObservation { left, right });
            let Some(prior) = prior else {
                return TruthValue::Unknown;
            };
            let crossed = if matches!(condition, ConditionNode::CrossesAbove { .. }) {
                left > right && prior.left <= prior.right
            } else {
                left < right && prior.left >= prior.right
            };
            if crossed {
                TruthValue::True
            } else {
                TruthValue::False
            }
        }
        ConditionNode::Between {
            value,
            lower,
            upper,
        } => match (
            data.resolve(value, date),
            data.resolve(lower, date),
            data.resolve(upper, date),
        ) {
            (Some(value), Some(lower), Some(upper)) if value >= lower && value <= upper => {
                TruthValue::True
            }
            (Some(_), Some(_), Some(_)) => TruthValue::False,
            _ => TruthValue::Unknown,
        },
        ConditionNode::All { conditions } => {
            let values = conditions
                .iter()
                .map(|condition| evaluate_condition(condition, date, data, cross_history, ordinal))
                .collect::<Vec<_>>();
            if values.contains(&TruthValue::False) {
                TruthValue::False
            } else if values.contains(&TruthValue::Unknown) {
                TruthValue::Unknown
            } else {
                TruthValue::True
            }
        }
        ConditionNode::Any { conditions } => {
            let values = conditions
                .iter()
                .map(|condition| evaluate_condition(condition, date, data, cross_history, ordinal))
                .collect::<Vec<_>>();
            if values.contains(&TruthValue::True) {
                TruthValue::True
            } else if values.contains(&TruthValue::Unknown) {
                TruthValue::Unknown
            } else {
                TruthValue::False
            }
        }
        ConditionNode::Not { condition } => {
            match evaluate_condition(condition, date, data, cross_history, ordinal) {
                TruthValue::True => TruthValue::False,
                TruthValue::False => TruthValue::True,
                TruthValue::Unknown => TruthValue::Unknown,
            }
        }
    }
}

#[derive(Clone)]
struct PendingTransition {
    planned_date: String,
    to_state: StrategyState,
}

fn allocation_for(allocations: &StrategyAllocations, state: StrategyState) -> &StrategyAllocation {
    match state {
        StrategyState::Active => &allocations.active,
        StrategyState::Inactive => &allocations.inactive,
    }
}

fn common_index_at_or_before(safe_dates: &[String], date: &str) -> Option<usize> {
    safe_dates
        .partition_point(|candidate| candidate.as_str() <= date)
        .checked_sub(1)
}

fn next_common_date<'a>(safe_dates: &'a [String], date: &str) -> Option<&'a str> {
    safe_dates
        .get(safe_dates.partition_point(|candidate| candidate.as_str() <= date))
        .map(String::as_str)
}

fn apply_initial_allocation(
    simulation: &mut BacktestSimulationInput,
    allocation: &StrategyAllocation,
) {
    for asset in &mut simulation.assets {
        asset.weight = allocation.weights[&asset.symbol];
    }
    simulation.execution.cash_target_percent = allocation.cash_target_percent;
}

pub fn execute(
    request: &TechnicalAnalysisRequest,
    strategy: &TechnicalStrategyDefinition,
    mut simulation: Option<BacktestSimulationInput>,
    supplied_safe_trade_dates: Option<Vec<String>>,
    supplied_evaluation_start_date: Option<String>,
    supplied_evaluation_end_date: Option<String>,
    control: Option<&dyn ComputeControl>,
) -> Result<TechnicalStrategyRunResult> {
    checkpoint(control)?;
    ensure!(
        request.response_mode == ResponseMode::FullSeries,
        "technical strategy requires technical_analysis.response_mode=full_series"
    );
    let (references, condition_node_count) =
        validate_strategy(request, strategy, simulation.as_ref())?;
    let (safe_trade_dates, evaluation_start_date, evaluation_end_date, safe_source) =
        if let Some(simulation) = simulation.as_ref() {
            (
                backtest::common_observation_dates(simulation)?,
                simulation.requested_start_date.clone(),
                simulation.end_date.clone(),
                "simulation_common_observations".to_owned(),
            )
        } else {
            (
            supplied_safe_trade_dates.context(
                "safe_trade_dates is required when technical strategy simulation is omitted",
            )?,
            supplied_evaluation_start_date.context(
                "evaluation_start_date is required when technical strategy simulation is omitted",
            )?,
            supplied_evaluation_end_date.context(
                "evaluation_end_date is required when technical strategy simulation is omitted",
            )?,
            "caller_supplied_common_observations".to_owned(),
        )
        };
    validate_dates(&safe_trade_dates)?;
    parse_iso_date(&evaluation_start_date)?;
    parse_iso_date(&evaluation_end_date)?;
    ensure!(
        evaluation_start_date <= evaluation_end_date,
        "evaluation_start_date must not exceed evaluation_end_date"
    );
    ensure!(
        safe_trade_dates
            .iter()
            .all(|date| date >= &evaluation_start_date && date <= &evaluation_end_date),
        "safe_trade_dates must fall inside the evaluation period"
    );

    let technical = analyze_technical_indicators(request, control)?;
    let data = evaluation_data(request, &technical, &references)?;
    let calculation_dates = request
        .instruments
        .iter()
        .flat_map(|instrument| instrument.bars.iter().map(|bar| bar.date.clone()))
        .collect::<BTreeSet<_>>();
    let timeline = calculation_dates
        .iter()
        .chain(safe_trade_dates.iter())
        .filter(|date| date.as_str() <= evaluation_end_date.as_str())
        .cloned()
        .collect::<BTreeSet<_>>();

    let mut state = strategy.initial_state;
    let mut state_entered_common_index = (strategy.initial_state == StrategyState::Active)
        .then_some(0_usize)
        .filter(|_| !safe_trade_dates.is_empty());
    let mut last_transition_common_index = None::<usize>;
    let mut pending = None::<PendingTransition>;
    let mut signals = Vec::<TechnicalSignal>::new();
    let mut target_weight_schedule = Vec::<TargetWeightScheduleEntry>::new();
    let mut active_cross_history = BTreeMap::new();
    let mut inactive_cross_history = BTreeMap::new();
    let mut active_unknown_count = 0;
    let mut inactive_unknown_count = 0;
    let mut minimum_holding_suppressed_count = 0;
    let mut cooldown_suppressed_count = 0;
    let mut pending_suppressed_count = 0;
    let mut terminal_no_safe_transition = None::<SignalTransition>;

    for (timeline_index, date) in timeline.into_iter().enumerate() {
        if timeline_index.is_multiple_of(1_024) {
            checkpoint(control)?;
        }
        if pending
            .as_ref()
            .is_some_and(|pending| pending.planned_date == date)
        {
            let applied = pending.take().expect("pending transition checked above");
            state = applied.to_state;
            let common_index = safe_trade_dates
                .binary_search(&date)
                .expect("planned dates are selected from safe_trade_dates");
            state_entered_common_index = Some(common_index);
            last_transition_common_index = Some(common_index);
        }
        if !calculation_dates.contains(&date) {
            continue;
        }

        let mut active_ordinal = 0;
        let active_value = evaluate_condition(
            &strategy.active_when,
            &date,
            &data,
            &mut active_cross_history,
            &mut active_ordinal,
        );
        let mut inactive_ordinal = 0;
        let inactive_value = evaluate_condition(
            &strategy.inactive_when,
            &date,
            &data,
            &mut inactive_cross_history,
            &mut inactive_ordinal,
        );
        if active_value == TruthValue::Unknown {
            active_unknown_count += 1;
        }
        if inactive_value == TruthValue::Unknown {
            inactive_unknown_count += 1;
        }
        if date < evaluation_start_date || date > evaluation_end_date {
            continue;
        }

        let (condition_value, transition, to_state) = match state {
            StrategyState::Inactive => (
                active_value,
                SignalTransition::Activate,
                StrategyState::Active,
            ),
            StrategyState::Active => (
                inactive_value,
                SignalTransition::Deactivate,
                StrategyState::Inactive,
            ),
        };
        if condition_value != TruthValue::True {
            continue;
        }
        if pending.is_some() {
            pending_suppressed_count += 1;
            continue;
        }
        let current_common_index = common_index_at_or_before(&safe_trade_dates, &date);
        if state == StrategyState::Active
            && strategy.minimum_holding_period > 0
            && current_common_index
                .zip(state_entered_common_index)
                .is_none_or(|(current, entered)| {
                    current.saturating_sub(entered) < strategy.minimum_holding_period
                })
        {
            minimum_holding_suppressed_count += 1;
            continue;
        }
        if strategy.cooldown_period > 0
            && current_common_index
                .zip(last_transition_common_index)
                .is_some_and(|(current, prior)| {
                    current.saturating_sub(prior) <= strategy.cooldown_period
                })
        {
            cooldown_suppressed_count += 1;
            continue;
        }
        if terminal_no_safe_transition == Some(transition) {
            continue;
        }

        ensure!(
            signals.len() < MAX_SIGNALS,
            "technical strategy generated more than {MAX_SIGNALS} signals"
        );
        let signal_id = format!("technical-signal-{:06}", signals.len() + 1);
        let target = allocation_for(&strategy.allocations, to_state);
        let planned_trade_date = next_common_date(&safe_trade_dates, &date).map(str::to_owned);
        let status = if planned_trade_date.is_some() {
            if simulation.is_some() {
                TechnicalSignalStatus::Applied
            } else {
                TechnicalSignalStatus::Planned
            }
        } else {
            TechnicalSignalStatus::NoSafeTradeDate
        };
        signals.push(TechnicalSignal {
            signal_id: signal_id.clone(),
            transition,
            calculation_date: date.clone(),
            signal_date: date.clone(),
            planned_trade_date: planned_trade_date.clone(),
            actual_application_date: None,
            from_state: state,
            to_state,
            target_weights: target.weights.clone(),
            cash_target_percent: target.cash_target_percent,
            status,
        });
        if let Some(planned_date) = planned_trade_date {
            ensure!(
                target_weight_schedule.len() < MAX_SIGNALS,
                "technical strategy generated more than {MAX_SIGNALS} schedule entries"
            );
            target_weight_schedule.push(TargetWeightScheduleEntry {
                date: planned_date.clone(),
                weights: target.weights.clone(),
                cash_target_percent: target.cash_target_percent,
                regime: Some(match to_state {
                    StrategyState::Active => "active".to_owned(),
                    StrategyState::Inactive => "inactive".to_owned(),
                }),
                action: Some(signal_id),
            });
            pending = Some(PendingTransition {
                planned_date,
                to_state,
            });
        } else {
            terminal_no_safe_transition = Some(transition);
        }
    }

    let backtest = if let Some(mut simulation) = simulation.take() {
        let initial = allocation_for(&strategy.allocations, strategy.initial_state);
        apply_initial_allocation(&mut simulation, initial);
        simulation.target_weight_schedule = target_weight_schedule.clone();
        let result = backtest::simulate_with_control(&simulation, control)?;
        for signal in &mut signals {
            if signal.status != TechnicalSignalStatus::Applied {
                continue;
            }
            let applied = result.target_weight_schedule.iter().find(|entry| {
                signal.planned_trade_date.as_deref() == Some(entry.scheduled_date.as_str())
                    && entry.action.as_deref() == Some(signal.signal_id.as_str())
            });
            let applied = applied.with_context(|| {
                format!(
                    "ledger did not apply generated technical signal {}",
                    signal.signal_id
                )
            })?;
            signal.actual_application_date = Some(applied.effective_date.clone());
        }
        Some(result)
    } else {
        None
    };

    checkpoint(control)?;
    Ok(TechnicalStrategyRunResult {
        technical_analysis: technical,
        technical_strategy: TechnicalStrategyEvaluation {
            schema_version: TECHNICAL_STRATEGY_RESULT_SCHEMA_VERSION.to_owned(),
            strategy_schema_version: strategy.schema_version.clone(),
            initial_state: strategy.initial_state,
            signals,
            target_weight_schedule,
            diagnostics: TechnicalStrategyDiagnostics {
                validation: "passed".to_owned(),
                condition_value_policy:
                    "three_valued_true_false_unknown_with_not_unknown_preserved".to_owned(),
                between_policy: "inclusive_lower_and_upper_bounds".to_owned(),
                crossing_policy:
                    "current_values_against_strictly_prior_jointly_available_observation".to_owned(),
                signal_timing_policy:
                    "bar_close_signal_applies_on_strictly_next_common_observation".to_owned(),
                safe_trade_date_source: safe_source,
                evaluation_start_date,
                evaluation_end_date,
                safe_trade_date_count: safe_trade_dates.len(),
                condition_node_count,
                active_unknown_count,
                inactive_unknown_count,
                minimum_holding_suppressed_count,
                cooldown_suppressed_count,
                pending_suppressed_count,
            },
        },
        backtest,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::date::add_days;

    fn technical_request(
        dates: &[String],
        closes: &[f64],
        volumes: &[Option<f64>],
    ) -> TechnicalAnalysisRequest {
        assert_eq!(dates.len(), closes.len());
        assert_eq!(dates.len(), volumes.len());
        serde_json::from_value(json!({
            "schema_version": crate::indicators::TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION,
            "response_mode": "full_series",
            "adjustment_policy": "adjusted",
            "instruments": [{
                "key": "KRW:AAA",
                "symbol": "AAA",
                "market": "KR",
                "currency": "KRW",
                "instrument_type": "stock",
                "bars": dates.iter().zip(closes).zip(volumes).map(|((date, close), volume)| json!({
                    "date": date,
                    "open": close,
                    "high": close + 1.0,
                    "low": (close - 1.0).max(0.01),
                    "close": close,
                    "volume": volume,
                })).collect::<Vec<_>>()
            }],
            "indicators": [{
                "id": "sma-one",
                "kind": "sma",
                "parameters": {"period": 1}
            }]
        }))
        .unwrap()
    }

    fn bar(field: BarField) -> Operand {
        Operand::Bar {
            instrument_key: "KRW:AAA".to_owned(),
            field,
        }
    }

    fn constant(value: f64) -> Operand {
        Operand::Constant { value }
    }

    fn allocation(weight: f64, cash: f64) -> StrategyAllocation {
        StrategyAllocation {
            weights: BTreeMap::from([("AAA".to_owned(), weight)]),
            cash_target_percent: cash,
        }
    }

    fn strategy(
        active_when: ConditionNode,
        inactive_when: ConditionNode,
    ) -> TechnicalStrategyDefinition {
        TechnicalStrategyDefinition {
            schema_version: TECHNICAL_STRATEGY_SCHEMA_VERSION.to_owned(),
            initial_state: StrategyState::Inactive,
            active_when,
            inactive_when,
            minimum_holding_period: 0,
            cooldown_period: 0,
            allocations: StrategyAllocations {
                active: allocation(100.0, 0.0),
                inactive: allocation(0.0, 100.0),
            },
        }
    }

    fn dates() -> Vec<String> {
        (0..5)
            .map(|offset| add_days("2024-01-01", offset).unwrap())
            .collect()
    }

    fn simulation(dates: &[String], closes: &[f64]) -> BacktestSimulationInput {
        serde_json::from_value(json!({
            "assets": [{
                "symbol": "AAA",
                "name": "AAA",
                "market": "KR",
                "currency": "KRW",
                "listDate": "2020-01-01",
                "weight": 100.0
            }],
            "prices": {
                "KRW:AAA": dates.iter().zip(closes).map(|(date, close)| json!({
                    "date": date,
                    "close": close,
                    "localClose": close,
                    "fxRate": 1.0,
                    "volume": 1000.0
                })).collect::<Vec<_>>()
            },
            "requestedStartDate": dates[0],
            "endDate": dates.last().unwrap(),
            "initialAmount": 1000000.0,
            "execution": {"cashTargetPercent": 0.0}
        }))
        .unwrap()
    }

    #[test]
    fn signal_only_crosses_use_prior_joint_observation_and_strictly_next_safe_date() {
        let dates = dates();
        let closes = vec![9.0, 11.0, 12.0, 8.0, 7.0];
        let request = technical_request(&dates, &closes, &vec![Some(100.0); dates.len()]);
        let definition = strategy(
            ConditionNode::CrossesAbove {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
            ConditionNode::CrossesBelow {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
        );
        let result = execute(
            &request,
            &definition,
            None,
            Some(dates[1..].to_vec()),
            Some(dates[1].clone()),
            Some(dates[4].clone()),
            None,
        )
        .unwrap();

        assert!(result.backtest.is_none());
        assert_eq!(result.technical_strategy.signals.len(), 2);
        assert_eq!(result.technical_strategy.signals[0].signal_date, dates[1]);
        assert_eq!(
            result.technical_strategy.signals[0]
                .planned_trade_date
                .as_deref(),
            Some(dates[2].as_str())
        );
        assert_eq!(
            result.technical_strategy.signals[0].status,
            TechnicalSignalStatus::Planned
        );
        assert_eq!(result.technical_strategy.signals[1].signal_date, dates[3]);
        assert_eq!(
            result.technical_strategy.signals[1]
                .planned_trade_date
                .as_deref(),
            Some(dates[4].as_str())
        );
        assert!(
            result
                .technical_strategy
                .signals
                .iter()
                .all(|signal| signal.signal_date < signal.planned_trade_date.clone().unwrap())
        );
    }

    #[test]
    fn missing_joint_observation_does_not_reset_cross_history() {
        let dates = dates();
        let closes = vec![10.0; dates.len()];
        let volumes = vec![Some(5.0), None, Some(15.0), Some(15.0), Some(15.0)];
        let request = technical_request(&dates, &closes, &volumes);
        let definition = strategy(
            ConditionNode::CrossesAbove {
                left: bar(BarField::Volume),
                right: constant(10.0),
            },
            ConditionNode::LessThan {
                left: constant(1.0),
                right: constant(0.0),
            },
        );
        let result = execute(
            &request,
            &definition,
            None,
            Some(dates.clone()),
            Some(dates[0].clone()),
            Some(dates[4].clone()),
            None,
        )
        .unwrap();
        assert_eq!(result.technical_strategy.signals.len(), 1);
        assert_eq!(result.technical_strategy.signals[0].signal_date, dates[2]);
        assert_eq!(
            result.technical_strategy.signals[0]
                .planned_trade_date
                .as_deref(),
            Some(dates[3].as_str())
        );
    }

    #[test]
    fn unknown_is_preserved_through_not_and_never_fabricates_a_signal() {
        let dates = dates();
        let closes = vec![10.0; dates.len()];
        let request = technical_request(&dates, &closes, &vec![None; dates.len()]);
        let definition = strategy(
            ConditionNode::Not {
                condition: Box::new(ConditionNode::GreaterThan {
                    left: bar(BarField::Volume),
                    right: constant(0.0),
                }),
            },
            ConditionNode::GreaterThan {
                left: constant(0.0),
                right: constant(1.0),
            },
        );
        let result = execute(
            &request,
            &definition,
            None,
            Some(dates.clone()),
            Some(dates[0].clone()),
            Some(dates[4].clone()),
            None,
        )
        .unwrap();
        assert!(result.technical_strategy.signals.is_empty());
        assert_eq!(
            result.technical_strategy.diagnostics.active_unknown_count,
            dates.len()
        );
    }

    #[test]
    fn minimum_holding_period_uses_common_observation_count() {
        let dates = dates();
        let closes = vec![8.0; dates.len()];
        let request = technical_request(&dates, &closes, &vec![Some(1.0); dates.len()]);
        let mut definition = strategy(
            ConditionNode::GreaterThan {
                left: constant(0.0),
                right: constant(1.0),
            },
            ConditionNode::LessThan {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
        );
        definition.initial_state = StrategyState::Active;
        definition.minimum_holding_period = 2;
        let result = execute(
            &request,
            &definition,
            None,
            Some(dates[1..].to_vec()),
            Some(dates[1].clone()),
            Some(dates[4].clone()),
            None,
        )
        .unwrap();
        assert_eq!(
            result
                .technical_strategy
                .diagnostics
                .minimum_holding_suppressed_count,
            2
        );
        assert_eq!(result.technical_strategy.signals[0].signal_date, dates[3]);
        assert_eq!(
            result.technical_strategy.signals[0]
                .planned_trade_date
                .as_deref(),
            Some(dates[4].as_str())
        );
    }

    #[test]
    fn no_future_safe_date_is_explicit_and_never_creates_a_schedule() {
        let dates = dates();
        let closes = vec![11.0; dates.len()];
        let request = technical_request(&dates, &closes, &vec![Some(1.0); dates.len()]);
        let definition = strategy(
            ConditionNode::GreaterThan {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
            ConditionNode::LessThan {
                left: constant(1.0),
                right: constant(0.0),
            },
        );
        let result = execute(
            &request,
            &definition,
            None,
            Some(vec![dates[4].clone()]),
            Some(dates[4].clone()),
            Some(dates[4].clone()),
            None,
        )
        .unwrap();
        assert_eq!(result.technical_strategy.signals.len(), 1);
        assert_eq!(
            result.technical_strategy.signals[0].status,
            TechnicalSignalStatus::NoSafeTradeDate
        );
        assert!(
            result.technical_strategy.signals[0]
                .planned_trade_date
                .is_none()
        );
        assert!(result.technical_strategy.target_weight_schedule.is_empty());
    }

    #[test]
    fn combined_run_joins_planned_schedule_to_actual_ledger_application() {
        let all_dates = dates();
        let closes = vec![9.0, 11.0, 12.0, 8.0, 7.0];
        let request = technical_request(&all_dates, &closes, &vec![Some(1000.0); all_dates.len()]);
        let definition = strategy(
            ConditionNode::CrossesAbove {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
            ConditionNode::CrossesBelow {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
        );
        let ledger = simulation(&all_dates[1..], &closes[1..]);
        let result = execute(
            &request,
            &definition,
            Some(ledger),
            Some(vec!["1900-01-01".to_owned()]),
            Some("1900-01-01".to_owned()),
            Some("1900-01-01".to_owned()),
            None,
        )
        .unwrap();
        let backtest = result.backtest.unwrap();
        assert_eq!(result.technical_strategy.signals.len(), 2);
        assert_eq!(backtest.target_weight_schedule.len(), 2);
        for signal in &result.technical_strategy.signals {
            assert_eq!(signal.status, TechnicalSignalStatus::Applied);
            assert_eq!(signal.actual_application_date, signal.planned_trade_date);
        }
        assert!(
            backtest
                .trades
                .iter()
                .any(|trade| trade.trigger == "regime_policy")
        );
        assert_eq!(
            result.technical_strategy.diagnostics.safe_trade_date_source,
            "simulation_common_observations"
        );
    }

    #[test]
    fn tree_limits_allocation_coverage_and_supplied_schedule_are_rejected() {
        let dates = dates();
        let closes = vec![10.0; dates.len()];
        let request = technical_request(&dates, &closes, &vec![Some(1.0); dates.len()]);
        let mut deeply_nested = ConditionNode::GreaterThan {
            left: bar(BarField::Close),
            right: constant(0.0),
        };
        for _ in 0..MAX_CONDITION_DEPTH {
            deeply_nested = ConditionNode::Not {
                condition: Box::new(deeply_nested),
            };
        }
        let invalid_depth = strategy(
            deeply_nested,
            ConditionNode::GreaterThan {
                left: constant(0.0),
                right: constant(1.0),
            },
        );
        assert!(
            execute(
                &request,
                &invalid_depth,
                None,
                Some(dates.clone()),
                Some(dates[0].clone()),
                Some(dates[4].clone()),
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("depth")
        );

        let mut invalid_symbol = strategy(
            ConditionNode::GreaterThan {
                left: bar(BarField::Close),
                right: constant(0.0),
            },
            ConditionNode::LessThan {
                left: constant(0.0),
                right: constant(1.0),
            },
        );
        invalid_symbol.allocations.active.weights = BTreeMap::from([("BBB".to_owned(), 100.0)]);
        invalid_symbol.allocations.inactive.weights = BTreeMap::from([("BBB".to_owned(), 0.0)]);
        assert!(
            execute(
                &request,
                &invalid_symbol,
                None,
                Some(dates.clone()),
                Some(dates[0].clone()),
                Some(dates[4].clone()),
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("present")
        );

        let valid = strategy(
            ConditionNode::GreaterThan {
                left: bar(BarField::Close),
                right: constant(0.0),
            },
            ConditionNode::LessThan {
                left: constant(0.0),
                right: constant(1.0),
            },
        );
        let mut ledger = simulation(&dates, &closes);
        ledger
            .target_weight_schedule
            .push(TargetWeightScheduleEntry {
                date: dates[1].clone(),
                weights: BTreeMap::from([("AAA".to_owned(), 100.0)]),
                cash_target_percent: 0.0,
                regime: None,
                action: None,
            });
        assert!(
            execute(&request, &valid, Some(ledger), None, None, None, None)
                .unwrap_err()
                .to_string()
                .contains("supplied targetWeightSchedule")
        );
    }

    #[test]
    fn future_ohlcv_changes_cannot_change_signal_prefix() {
        let dates = dates();
        let closes = vec![9.0, 11.0, 12.0, 8.0, 7.0];
        let request = technical_request(&dates, &closes, &vec![Some(1.0); dates.len()]);
        let definition = strategy(
            ConditionNode::CrossesAbove {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
            ConditionNode::CrossesBelow {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
        );
        let base = execute(
            &request,
            &definition,
            None,
            Some(dates[1..=3].to_vec()),
            Some(dates[1].clone()),
            Some(dates[3].clone()),
            None,
        )
        .unwrap();
        let mut changed_closes = closes.clone();
        changed_closes[4] = 1_000_000.0;
        let changed = technical_request(&dates, &changed_closes, &vec![Some(1.0); dates.len()]);
        let future_changed = execute(
            &changed,
            &definition,
            None,
            Some(dates[1..=3].to_vec()),
            Some(dates[1].clone()),
            Some(dates[3].clone()),
            None,
        )
        .unwrap();
        assert_eq!(
            base.technical_strategy.signals,
            future_changed.technical_strategy.signals
        );
        assert_eq!(
            base.technical_strategy.diagnostics.active_unknown_count,
            future_changed
                .technical_strategy
                .diagnostics
                .active_unknown_count
        );
    }

    #[test]
    fn generated_signal_and_schedule_caps_are_enforced() {
        let count = MAX_SIGNALS + 2;
        let dates = (0..count)
            .map(|offset| add_days("2000-01-01", offset as i64).unwrap())
            .collect::<Vec<_>>();
        let closes = (0..count)
            .map(|index| if index.is_multiple_of(2) { 11.0 } else { 9.0 })
            .collect::<Vec<_>>();
        let request = technical_request(&dates, &closes, &vec![Some(1.0); count]);
        let definition = strategy(
            ConditionNode::GreaterThan {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
            ConditionNode::LessThan {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
        );
        assert!(
            execute(
                &request,
                &definition,
                None,
                Some(dates.clone()),
                Some(dates[0].clone()),
                Some(dates.last().unwrap().clone()),
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("more than 10000")
        );
    }

    #[test]
    fn between_all_any_and_not_use_inclusive_three_valued_composition() {
        let dates = dates();
        let closes = vec![9.0; dates.len()];
        let request = technical_request(&dates, &closes, &vec![Some(2.0); dates.len()]);
        let definition = strategy(
            ConditionNode::All {
                conditions: vec![
                    ConditionNode::Between {
                        value: bar(BarField::Close),
                        lower: constant(9.0),
                        upper: constant(11.0),
                    },
                    ConditionNode::Any {
                        conditions: vec![
                            ConditionNode::GreaterThan {
                                left: bar(BarField::Volume),
                                right: constant(0.0),
                            },
                            ConditionNode::LessThan {
                                left: constant(1.0),
                                right: constant(0.0),
                            },
                        ],
                    },
                    ConditionNode::Not {
                        condition: Box::new(ConditionNode::LessThan {
                            left: bar(BarField::Close),
                            right: constant(9.0),
                        }),
                    },
                ],
            },
            ConditionNode::LessThan {
                left: constant(1.0),
                right: constant(0.0),
            },
        );
        let result = execute(
            &request,
            &definition,
            None,
            Some(dates.clone()),
            Some(dates[0].clone()),
            Some(dates[4].clone()),
            None,
        )
        .unwrap();
        assert_eq!(result.technical_strategy.signals.len(), 1);
        assert_eq!(result.technical_strategy.signals[0].signal_date, dates[0]);
        assert_eq!(
            result.technical_strategy.signals[0]
                .planned_trade_date
                .as_deref(),
            Some(dates[1].as_str())
        );
    }

    #[test]
    fn cooldown_counts_common_observations_after_an_applied_transition() {
        let dates = (0..6)
            .map(|offset| add_days("2024-02-01", offset).unwrap())
            .collect::<Vec<_>>();
        let closes = vec![11.0, 9.0, 9.0, 9.0, 9.0, 9.0];
        let request = technical_request(&dates, &closes, &vec![Some(1.0); dates.len()]);
        let mut definition = strategy(
            ConditionNode::GreaterThan {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
            ConditionNode::LessThan {
                left: bar(BarField::Close),
                right: constant(10.0),
            },
        );
        definition.cooldown_period = 2;
        let result = execute(
            &request,
            &definition,
            None,
            Some(dates.clone()),
            Some(dates[0].clone()),
            Some(dates[5].clone()),
            None,
        )
        .unwrap();
        assert_eq!(result.technical_strategy.signals.len(), 2);
        assert_eq!(
            result.technical_strategy.signals[0].transition,
            SignalTransition::Activate
        );
        assert_eq!(result.technical_strategy.signals[1].signal_date, dates[4]);
        assert_eq!(
            result.technical_strategy.signals[1]
                .planned_trade_date
                .as_deref(),
            Some(dates[5].as_str())
        );
        assert_eq!(
            result
                .technical_strategy
                .diagnostics
                .cooldown_suppressed_count,
            3
        );
    }

    #[test]
    fn unknown_indicator_fields_and_volume_profile_references_are_rejected() {
        let dates = dates();
        let closes = vec![10.0; dates.len()];
        let request = technical_request(&dates, &closes, &vec![Some(1.0); dates.len()]);
        let invalid_reference = strategy(
            ConditionNode::GreaterThan {
                left: Operand::Indicator {
                    instrument_key: "KRW:AAA".to_owned(),
                    indicator_id: "sma-one".to_owned(),
                    field: "not_a_field".to_owned(),
                },
                right: constant(0.0),
            },
            ConditionNode::LessThan {
                left: constant(1.0),
                right: constant(0.0),
            },
        );
        assert!(
            execute(
                &request,
                &invalid_reference,
                None,
                Some(dates.clone()),
                Some(dates[0].clone()),
                Some(dates[4].clone()),
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("unknown indicator output field")
        );

        let mut profile_request = request;
        profile_request.indicators = vec![
            serde_json::from_value(json!({
                "id": "profile",
                "kind": "volume_profile",
                "parameters": {"bucket_count": 5}
            }))
            .unwrap(),
        ];
        let profile_reference = strategy(
            ConditionNode::GreaterThan {
                left: Operand::Indicator {
                    instrument_key: "KRW:AAA".to_owned(),
                    indicator_id: "profile".to_owned(),
                    field: "point_of_control".to_owned(),
                },
                right: constant(0.0),
            },
            ConditionNode::LessThan {
                left: constant(1.0),
                right: constant(0.0),
            },
        );
        assert!(
            execute(
                &profile_request,
                &profile_reference,
                None,
                Some(dates.clone()),
                Some(dates[0].clone()),
                Some(dates[4].clone()),
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("volume_profile")
        );
    }

    #[test]
    fn krw_converted_technical_bars_match_usd_simulation_ledger_closes() {
        let dates = (0..3)
            .map(|offset| add_days("2024-03-01", offset).unwrap())
            .collect::<Vec<_>>();
        let converted = vec![130_000.0, 132_600.0, 135_200.0];
        let request = technical_request(&dates, &converted, &vec![Some(1_000.0); dates.len()]);
        let definition = strategy(
            ConditionNode::GreaterThan {
                left: bar(BarField::Close),
                right: constant(100_000.0),
            },
            ConditionNode::LessThan {
                left: constant(1.0),
                right: constant(0.0),
            },
        );
        let ledger: BacktestSimulationInput = serde_json::from_value(json!({
            "assets": [{
                "symbol": "AAA",
                "name": "AAA",
                "market": "US",
                "currency": "USD",
                "listDate": "2020-01-01",
                "weight": 100.0
            }],
            "prices": {
                "USD:AAA": [
                    {"date": dates[0], "close": converted[0], "localClose": 100.0, "fxRate": 1300.0},
                    {"date": dates[1], "close": converted[1], "localClose": 102.0, "fxRate": 1300.0},
                    {"date": dates[2], "close": converted[2], "localClose": 104.0, "fxRate": 1300.0}
                ]
            },
            "requestedStartDate": dates[0],
            "endDate": dates[2],
            "initialAmount": 1000000.0,
            "execution": {"cashTargetPercent": 0.0}
        }))
        .unwrap();
        let result = execute(
            &request,
            &definition,
            Some(ledger.clone()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(result.backtest.is_some());

        let mut inconsistent = request;
        inconsistent.instruments[0].bars[1].close += 10.0;
        inconsistent.instruments[0].bars[1].high += 10.0;
        assert!(
            execute(
                &inconsistent,
                &definition,
                Some(ledger),
                None,
                None,
                None,
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("close values disagree")
        );
    }
}
