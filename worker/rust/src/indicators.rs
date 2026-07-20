use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::control::{ComputeControl, checkpoint};
use crate::date::parse_iso_date;

pub const INDICATOR_ENGINE_VERSION: &str = "technical-indicators/1.5.0";
pub const TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION: &str = "technical-analysis-request/v1";
pub const TECHNICAL_ANALYSIS_RESULT_SCHEMA_VERSION: &str = "technical-analysis-result/v1";

const MAX_INSTRUMENTS: usize = 100;
const MAX_BARS_PER_INSTRUMENT: usize = 100_000;
const MAX_TOTAL_BARS: usize = 2_000_000;
const MAX_INDICATOR_DEFINITIONS: usize = 256;
const MAX_VOLUME_PROFILE_BUCKETS: usize = 200;
const MAX_VOLUME_PROFILE_OBSERVATIONS: usize = 20_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseMode {
    FullSeries,
    LatestSummary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdjustmentPolicy {
    Adjusted,
    Unadjusted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstrumentType {
    Stock,
    Etf,
    Index,
    Fund,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum IndicatorKind {
    Sma,
    Ema,
    Rsi,
    Macd,
    BollingerBands,
    Atr,
    DonchianChannel,
    BenchmarkRelativeStrength,
    FiftyTwoWeekHighLowPosition,
    MovingAverageDistance,
    AdxDmi,
    StochasticOscillator,
    Roc,
    KeltnerChannel,
    Supertrend,
    HistoricalVolatility,
    NormalizedAtr,
    BollingerBandWidthPercentB,
    Aroon,
    Cci,
    WilliamsR,
    ParabolicSar,
    ChoppinessIndex,
    VolumeSma,
    RelativeVolume,
    Obv,
    Mfi,
    Cmf,
    AccumulationDistributionLine,
    VwapAnchoredVwap,
    VolumeProfile,
}

const ALL_INDICATOR_KINDS: [IndicatorKind; 31] = [
    IndicatorKind::Sma,
    IndicatorKind::Ema,
    IndicatorKind::Rsi,
    IndicatorKind::Macd,
    IndicatorKind::BollingerBands,
    IndicatorKind::Atr,
    IndicatorKind::DonchianChannel,
    IndicatorKind::BenchmarkRelativeStrength,
    IndicatorKind::FiftyTwoWeekHighLowPosition,
    IndicatorKind::MovingAverageDistance,
    IndicatorKind::AdxDmi,
    IndicatorKind::StochasticOscillator,
    IndicatorKind::Roc,
    IndicatorKind::KeltnerChannel,
    IndicatorKind::Supertrend,
    IndicatorKind::HistoricalVolatility,
    IndicatorKind::NormalizedAtr,
    IndicatorKind::BollingerBandWidthPercentB,
    IndicatorKind::Aroon,
    IndicatorKind::Cci,
    IndicatorKind::WilliamsR,
    IndicatorKind::ParabolicSar,
    IndicatorKind::ChoppinessIndex,
    IndicatorKind::VolumeSma,
    IndicatorKind::RelativeVolume,
    IndicatorKind::Obv,
    IndicatorKind::Mfi,
    IndicatorKind::Cmf,
    IndicatorKind::AccumulationDistributionLine,
    IndicatorKind::VwapAnchoredVwap,
    IndicatorKind::VolumeProfile,
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndicatorCategory {
    Trend,
    Momentum,
    Volatility,
    Breakout,
    RelativeStrength,
    Volume,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndicatorPanel {
    Price,
    Oscillator,
    Volume,
    Profile,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RequiredInput {
    Open,
    High,
    Low,
    Close,
    Volume,
    BenchmarkClose,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParameterType {
    Integer,
    Number,
    Enum,
    InstrumentKey,
    IsoDate,
    Boolean,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParameterDescriptor {
    #[serde(rename = "type")]
    pub parameter_type: ParameterType,
    pub required: bool,
    pub default: Option<Value>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub allowed_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndicatorCatalogEntry {
    pub kind: IndicatorKind,
    pub category: IndicatorCategory,
    pub panel: IndicatorPanel,
    pub required_inputs: Vec<RequiredInput>,
    pub output_fields: Vec<String>,
    pub parameters: BTreeMap<String, ParameterDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OhlcvBar {
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    #[serde(default)]
    pub volume: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InstrumentSeries {
    pub key: String,
    pub symbol: String,
    pub market: String,
    pub currency: String,
    pub instrument_type: InstrumentType,
    pub bars: Vec<OhlcvBar>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IndicatorDefinition {
    pub id: String,
    pub kind: IndicatorKind,
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
    #[serde(default)]
    pub instrument_keys: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TechnicalAnalysisRequest {
    pub schema_version: String,
    pub response_mode: ResponseMode,
    pub adjustment_policy: AdjustmentPolicy,
    pub instruments: Vec<InstrumentSeries>,
    pub indicators: Vec<IndicatorDefinition>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AvailabilityStatus {
    Available,
    Partial,
    InsufficientHistory,
    VolumeUnavailable,
    UnsupportedInstrument,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Availability {
    pub status: AvailabilityStatus,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WarmupState {
    WarmingUp,
    Ready,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WarmupMetadata {
    pub required_observations: usize,
    pub observed_observations: usize,
    pub state: WarmupState,
    pub first_available_date: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PointState {
    Warmup,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IndicatorPoint {
    pub date: String,
    pub state: PointState,
    pub values: BTreeMap<String, Option<f64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IndicatorCalculation {
    pub instrument_key: String,
    pub indicator_id: String,
    pub kind: IndicatorKind,
    pub parameters: BTreeMap<String, Value>,
    pub availability: Availability,
    pub warmup: WarmupMetadata,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<VolumeProfileResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<IndicatorPoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<IndicatorPoint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VolumeProfileBucket {
    pub index: usize,
    pub price_low: f64,
    pub price_high: f64,
    pub price_mid: f64,
    pub volume: f64,
    pub volume_percent: f64,
    pub in_value_area: bool,
    pub is_point_of_control: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VolumeProfileResult {
    pub schema_version: String,
    pub from_date: String,
    pub to_date: String,
    pub price_source: String,
    pub requested_bucket_count: usize,
    pub effective_bucket_count: usize,
    pub price_min: f64,
    pub price_max: f64,
    pub bucket_width: f64,
    pub total_volume: f64,
    pub included_observations: usize,
    pub missing_volume_observations: usize,
    pub value_area_percent: f64,
    pub point_of_control: f64,
    pub value_area_high: f64,
    pub value_area_low: f64,
    pub buckets: Vec<VolumeProfileBucket>,
    pub approximation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TechnicalDiagnostics {
    pub validation: String,
    pub deterministic_order: String,
    pub adjustment_policy: AdjustmentPolicy,
    pub policies: CalculationPolicies,
    pub instrument_count: usize,
    pub indicator_definition_count: usize,
    pub calculation_count: usize,
    pub total_bar_count: usize,
    pub catalog: Vec<IndicatorCatalogEntry>,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CalculationPolicies {
    pub ohlc_missing: String,
    pub volume_missing: String,
    pub volume_input_unit: String,
    pub volume_adjustment: String,
    pub volume_currency_conversion: String,
    pub date_order: String,
    pub timeframe: String,
    pub warmup: String,
    pub unavailable_value: String,
    pub standard_deviation: String,
    pub ema_seed: String,
    pub wilder_seed: String,
    pub true_range_initial: String,
    pub numeric_rounding: String,
    pub vwap_price_basis: String,
    pub vwap_reset: String,
    pub anchored_vwap_anchor: String,
    pub volume_profile_approximation: String,
    pub volume_profile_value_area: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TechnicalAnalysisResult {
    pub schema_version: String,
    pub indicator_engine_version: String,
    pub response_mode: ResponseMode,
    pub adjustment_policy: AdjustmentPolicy,
    pub calculations: Vec<IndicatorCalculation>,
    pub diagnostics: TechnicalDiagnostics,
}

#[derive(Debug, Clone)]
struct ValidatedIndicatorDefinition {
    id: String,
    kind: IndicatorKind,
    parameters: BTreeMap<String, Value>,
    instrument_keys: Vec<String>,
    required_observations: usize,
}

fn integer(
    default: Option<i64>,
    minimum: i64,
    maximum: i64,
    required: bool,
) -> ParameterDescriptor {
    ParameterDescriptor {
        parameter_type: ParameterType::Integer,
        required,
        default: default.map(|value| json!(value)),
        minimum: Some(minimum as f64),
        maximum: Some(maximum as f64),
        allowed_values: vec![],
    }
}

fn number(default: Option<f64>, minimum: f64, maximum: f64, required: bool) -> ParameterDescriptor {
    ParameterDescriptor {
        parameter_type: ParameterType::Number,
        required,
        default: default.map(|value| json!(value)),
        minimum: Some(minimum),
        maximum: Some(maximum),
        allowed_values: vec![],
    }
}

fn enumeration(default: Option<&str>, values: &[&str], required: bool) -> ParameterDescriptor {
    ParameterDescriptor {
        parameter_type: ParameterType::Enum,
        required,
        default: default.map(|value| json!(value)),
        minimum: None,
        maximum: None,
        allowed_values: values.iter().map(|value| (*value).to_owned()).collect(),
    }
}

fn instrument_key(required: bool) -> ParameterDescriptor {
    ParameterDescriptor {
        parameter_type: ParameterType::InstrumentKey,
        required,
        default: None,
        minimum: None,
        maximum: None,
        allowed_values: vec![],
    }
}

fn iso_date(required: bool) -> ParameterDescriptor {
    ParameterDescriptor {
        parameter_type: ParameterType::IsoDate,
        required,
        default: None,
        minimum: None,
        maximum: None,
        allowed_values: vec![],
    }
}

fn parameter_map(
    entries: impl IntoIterator<Item = (&'static str, ParameterDescriptor)>,
) -> BTreeMap<String, ParameterDescriptor> {
    entries
        .into_iter()
        .map(|(name, descriptor)| (name.to_owned(), descriptor))
        .collect()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

pub fn catalog_entry(kind: IndicatorKind) -> IndicatorCatalogEntry {
    use IndicatorCategory as Category;
    use IndicatorKind as Kind;
    use IndicatorPanel as Panel;
    use RequiredInput as Input;

    let source = || {
        enumeration(
            Some("close"),
            &["open", "high", "low", "close", "typical_price"],
            false,
        )
    };
    let period = |default| integer(Some(default), 1, 10_000, false);
    let (category, panel, required_inputs, output_fields, parameters) = match kind {
        Kind::Sma => (
            Category::Trend,
            Panel::Price,
            vec![Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(20)), ("source", source())]),
        ),
        Kind::Ema => (
            Category::Trend,
            Panel::Price,
            vec![Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(20)), ("source", source())]),
        ),
        Kind::Rsi => (
            Category::Momentum,
            Panel::Oscillator,
            vec![Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(14)), ("source", source())]),
        ),
        Kind::Macd => (
            Category::Momentum,
            Panel::Oscillator,
            vec![Input::Close],
            strings(&["macd", "signal", "histogram"]),
            parameter_map([
                ("fast_period", period(12)),
                ("signal_period", period(9)),
                ("slow_period", period(26)),
                ("source", source()),
            ]),
        ),
        Kind::BollingerBands => (
            Category::Volatility,
            Panel::Price,
            vec![Input::Close],
            strings(&["upper", "middle", "lower"]),
            parameter_map([
                ("period", period(20)),
                ("source", source()),
                ("stddev_multiplier", number(Some(2.0), 0.1, 20.0, false)),
            ]),
        ),
        Kind::Atr => (
            Category::Volatility,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["atr"]),
            parameter_map([("period", period(14))]),
        ),
        Kind::DonchianChannel => (
            Category::Breakout,
            Panel::Price,
            vec![Input::High, Input::Low],
            strings(&["upper", "middle", "lower"]),
            parameter_map([("period", period(20))]),
        ),
        Kind::BenchmarkRelativeStrength => (
            Category::RelativeStrength,
            Panel::Oscillator,
            vec![Input::Close, Input::BenchmarkClose],
            strings(&["relative_strength"]),
            parameter_map([("benchmark_key", instrument_key(true))]),
        ),
        Kind::FiftyTwoWeekHighLowPosition => (
            Category::Breakout,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["rolling_high", "rolling_low", "position_percent"]),
            parameter_map([("period", period(252))]),
        ),
        Kind::MovingAverageDistance => (
            Category::Trend,
            Panel::Oscillator,
            vec![Input::Close],
            strings(&["moving_average", "distance_percent"]),
            parameter_map([
                (
                    "average_type",
                    enumeration(Some("sma"), &["sma", "ema"], false),
                ),
                ("period", period(20)),
                ("source", source()),
            ]),
        ),
        Kind::AdxDmi => (
            Category::Trend,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["adx", "plus_di", "minus_di"]),
            parameter_map([("period", period(14))]),
        ),
        Kind::StochasticOscillator => (
            Category::Momentum,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["percent_k", "percent_d"]),
            parameter_map([
                ("lookback_period", period(14)),
                ("smooth_d", period(3)),
                ("smooth_k", period(3)),
            ]),
        ),
        Kind::Roc => (
            Category::Momentum,
            Panel::Oscillator,
            vec![Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(12)), ("source", source())]),
        ),
        Kind::KeltnerChannel => (
            Category::Volatility,
            Panel::Price,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["upper", "middle", "lower"]),
            parameter_map([
                ("atr_period", period(10)),
                ("ema_period", period(20)),
                ("multiplier", number(Some(2.0), 0.1, 20.0, false)),
            ]),
        ),
        Kind::Supertrend => (
            Category::Trend,
            Panel::Price,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["supertrend", "direction"]),
            parameter_map([
                ("atr_period", period(10)),
                ("multiplier", number(Some(3.0), 0.1, 20.0, false)),
            ]),
        ),
        Kind::HistoricalVolatility => (
            Category::Volatility,
            Panel::Oscillator,
            vec![Input::Close],
            strings(&["value"]),
            parameter_map([
                ("annualization", integer(Some(252), 1, 10_000, false)),
                ("period", period(20)),
                (
                    "return_type",
                    enumeration(Some("log"), &["simple", "log"], false),
                ),
            ]),
        ),
        Kind::NormalizedAtr => (
            Category::Volatility,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(14))]),
        ),
        Kind::BollingerBandWidthPercentB => (
            Category::Volatility,
            Panel::Oscillator,
            vec![Input::Close],
            strings(&["bandwidth", "percent_b", "upper", "middle", "lower"]),
            parameter_map([
                ("period", period(20)),
                ("source", source()),
                ("stddev_multiplier", number(Some(2.0), 0.1, 20.0, false)),
            ]),
        ),
        Kind::Aroon => (
            Category::Trend,
            Panel::Oscillator,
            vec![Input::High, Input::Low],
            strings(&["aroon_up", "aroon_down", "oscillator"]),
            parameter_map([("period", period(25))]),
        ),
        Kind::Cci => (
            Category::Momentum,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["value"]),
            parameter_map([
                ("constant", number(Some(0.015), 0.000_001, 1.0, false)),
                ("period", period(20)),
            ]),
        ),
        Kind::WilliamsR => (
            Category::Momentum,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(14))]),
        ),
        Kind::ParabolicSar => (
            Category::Trend,
            Panel::Price,
            vec![Input::High, Input::Low],
            strings(&["sar", "direction"]),
            parameter_map([
                ("max_step", number(Some(0.2), 0.000_1, 1.0, false)),
                ("step", number(Some(0.02), 0.000_1, 1.0, false)),
            ]),
        ),
        Kind::ChoppinessIndex => (
            Category::Trend,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close],
            strings(&["value"]),
            parameter_map([("period", period(14))]),
        ),
        Kind::VolumeSma => (
            Category::Volume,
            Panel::Volume,
            vec![Input::Volume],
            strings(&["value"]),
            parameter_map([("period", period(20))]),
        ),
        Kind::RelativeVolume => (
            Category::Volume,
            Panel::Volume,
            vec![Input::Volume],
            strings(&["value"]),
            parameter_map([("period", period(20))]),
        ),
        Kind::Obv => (
            Category::Volume,
            Panel::Volume,
            vec![Input::Close, Input::Volume],
            strings(&["value"]),
            BTreeMap::new(),
        ),
        Kind::Mfi => (
            Category::Volume,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close, Input::Volume],
            strings(&["value"]),
            parameter_map([("period", period(14))]),
        ),
        Kind::Cmf => (
            Category::Volume,
            Panel::Oscillator,
            vec![Input::High, Input::Low, Input::Close, Input::Volume],
            strings(&["value"]),
            parameter_map([("period", period(20))]),
        ),
        Kind::AccumulationDistributionLine => (
            Category::Volume,
            Panel::Volume,
            vec![Input::High, Input::Low, Input::Close, Input::Volume],
            strings(&["value"]),
            BTreeMap::new(),
        ),
        Kind::VwapAnchoredVwap => (
            Category::Volume,
            Panel::Price,
            vec![Input::High, Input::Low, Input::Close, Input::Volume],
            strings(&["vwap", "anchored_vwap"]),
            parameter_map([
                (
                    "anchor",
                    enumeration(
                        Some("period_start"),
                        &[
                            "period_start",
                            "user_date",
                            "recent_high",
                            "recent_low",
                            "signal_date",
                        ],
                        false,
                    ),
                ),
                ("anchor_date", iso_date(false)),
                ("lookback_period", integer(Some(20), 1, 10_000, false)),
                (
                    "mode",
                    enumeration(Some("both"), &["vwap", "anchored", "both"], false),
                ),
            ]),
        ),
        Kind::VolumeProfile => (
            Category::Volume,
            Panel::Profile,
            vec![Input::High, Input::Low, Input::Close, Input::Volume],
            strings(&["point_of_control", "value_area_high", "value_area_low"]),
            parameter_map([
                ("bucket_count", integer(Some(24), 5, 200, false)),
                (
                    "price_source",
                    enumeration(Some("typical_price"), &["close", "typical_price"], false),
                ),
                ("value_area_percent", number(Some(70.0), 50.0, 99.0, false)),
            ]),
        ),
    };
    IndicatorCatalogEntry {
        kind,
        category,
        panel,
        required_inputs,
        output_fields,
        parameters,
    }
}

pub fn indicator_catalog() -> Vec<IndicatorCatalogEntry> {
    ALL_INDICATOR_KINDS
        .iter()
        .copied()
        .map(catalog_entry)
        .collect()
}

fn non_empty_bounded(value: &str, maximum: usize, field: &str) -> Result<()> {
    ensure!(!value.trim().is_empty(), "{field} must not be empty");
    ensure!(value.len() <= maximum, "{field} exceeds {maximum} bytes");
    ensure!(
        value == value.trim(),
        "{field} must not have surrounding whitespace"
    );
    Ok(())
}

fn validate_bar(bar: &OhlcvBar, previous_date: Option<&str>, instrument_key: &str) -> Result<()> {
    parse_iso_date(&bar.date).with_context(|| {
        format!(
            "instrument {instrument_key} has invalid bar date {}",
            bar.date
        )
    })?;
    if let Some(previous) = previous_date {
        ensure!(
            previous < bar.date.as_str(),
            "instrument {instrument_key} bars must be strictly date-ascending without duplicates"
        );
    }
    ensure!(
        [bar.open, bar.high, bar.low, bar.close]
            .iter()
            .all(|value| value.is_finite() && *value > 0.0),
        "instrument {instrument_key} OHLC values must be finite and positive at {}",
        bar.date
    );
    ensure!(
        bar.high >= bar.open.max(bar.close).max(bar.low)
            && bar.low <= bar.open.min(bar.close).min(bar.high),
        "instrument {instrument_key} OHLC range is inconsistent at {}",
        bar.date
    );
    ensure!(
        bar.volume
            .is_none_or(|volume| volume.is_finite() && volume >= 0.0),
        "instrument {instrument_key} volume must be finite and non-negative at {}",
        bar.date
    );
    Ok(())
}

fn validate_parameter(
    definition_id: &str,
    name: &str,
    value: &Value,
    descriptor: &ParameterDescriptor,
    instrument_keys: &BTreeSet<String>,
) -> Result<()> {
    let invalid =
        || anyhow::anyhow!("indicator {definition_id} parameter {name} has an invalid value");
    match descriptor.parameter_type {
        ParameterType::Integer => {
            let number = value.as_i64().ok_or_else(invalid)?;
            ensure!(
                descriptor
                    .minimum
                    .is_none_or(|minimum| number as f64 >= minimum)
                    && descriptor
                        .maximum
                        .is_none_or(|maximum| number as f64 <= maximum),
                "indicator {definition_id} parameter {name} is outside its allowed range"
            );
        }
        ParameterType::Number => {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(invalid)?;
            ensure!(
                descriptor.minimum.is_none_or(|minimum| number >= minimum)
                    && descriptor.maximum.is_none_or(|maximum| number <= maximum),
                "indicator {definition_id} parameter {name} is outside its allowed range"
            );
        }
        ParameterType::Enum => {
            let selected = value.as_str().ok_or_else(invalid)?;
            ensure!(
                descriptor
                    .allowed_values
                    .iter()
                    .any(|item| item == selected),
                "indicator {definition_id} parameter {name} is not a supported option"
            );
        }
        ParameterType::InstrumentKey => {
            let selected = value.as_str().ok_or_else(invalid)?;
            ensure!(
                instrument_keys.contains(selected),
                "indicator {definition_id} parameter {name} references an unknown instrument"
            );
        }
        ParameterType::IsoDate => {
            let selected = value.as_str().ok_or_else(invalid)?;
            parse_iso_date(selected).with_context(|| {
                format!("indicator {definition_id} parameter {name} must be an ISO date")
            })?;
        }
        ParameterType::Boolean => {
            ensure!(
                value.is_boolean(),
                "indicator {definition_id} parameter {name} must be boolean"
            );
        }
    }
    Ok(())
}

fn parameter_usize(parameters: &BTreeMap<String, Value>, name: &str) -> usize {
    parameters
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .expect("catalog validation supplies a positive bounded integer")
}

fn required_observations(kind: IndicatorKind, parameters: &BTreeMap<String, Value>) -> usize {
    use IndicatorKind as Kind;
    match kind {
        Kind::Sma
        | Kind::Ema
        | Kind::BollingerBands
        | Kind::DonchianChannel
        | Kind::FiftyTwoWeekHighLowPosition
        | Kind::MovingAverageDistance
        | Kind::NormalizedAtr
        | Kind::BollingerBandWidthPercentB
        | Kind::Cci
        | Kind::WilliamsR
        | Kind::ChoppinessIndex
        | Kind::VolumeSma
        | Kind::Cmf => parameter_usize(parameters, "period"),
        Kind::Rsi | Kind::Roc | Kind::HistoricalVolatility | Kind::RelativeVolume | Kind::Mfi => {
            parameter_usize(parameters, "period") + 1
        }
        Kind::Macd => {
            parameter_usize(parameters, "slow_period")
                + parameter_usize(parameters, "signal_period")
                - 1
        }
        Kind::Atr | Kind::Supertrend => parameter_usize(
            parameters,
            if kind == Kind::Atr {
                "period"
            } else {
                "atr_period"
            },
        ),
        Kind::AdxDmi => parameter_usize(parameters, "period") * 2,
        Kind::StochasticOscillator => {
            parameter_usize(parameters, "lookback_period")
                + parameter_usize(parameters, "smooth_k")
                + parameter_usize(parameters, "smooth_d")
                - 2
        }
        Kind::KeltnerChannel => {
            parameter_usize(parameters, "ema_period").max(parameter_usize(parameters, "atr_period"))
        }
        Kind::Aroon => parameter_usize(parameters, "period") + 1,
        Kind::ParabolicSar => 2,
        Kind::VwapAnchoredVwap => {
            let anchor = parameters["anchor"].as_str().unwrap();
            let mode = parameters["mode"].as_str().unwrap();
            if mode != "vwap" && matches!(anchor, "recent_high" | "recent_low") {
                parameter_usize(parameters, "lookback_period")
            } else {
                1
            }
        }
        Kind::BenchmarkRelativeStrength
        | Kind::Obv
        | Kind::AccumulationDistributionLine
        | Kind::VolumeProfile => 1,
    }
}

fn normalize_definition(
    definition: &IndicatorDefinition,
    instrument_keys: &BTreeSet<String>,
) -> Result<ValidatedIndicatorDefinition> {
    non_empty_bounded(&definition.id, 128, "indicator id")?;
    let catalog = catalog_entry(definition.kind);
    for name in definition.parameters.keys() {
        ensure!(
            catalog.parameters.contains_key(name),
            "indicator {} has unsupported parameter {name}",
            definition.id
        );
    }
    let mut parameters = BTreeMap::new();
    for (name, descriptor) in &catalog.parameters {
        let value = definition
            .parameters
            .get(name)
            .cloned()
            .or_else(|| descriptor.default.clone());
        if descriptor.required {
            ensure!(
                value.is_some(),
                "indicator {} requires parameter {name}",
                definition.id
            );
        }
        if let Some(value) = value {
            validate_parameter(&definition.id, name, &value, descriptor, instrument_keys)?;
            parameters.insert(name.clone(), value);
        }
    }
    match definition.kind {
        IndicatorKind::Macd => ensure!(
            parameter_usize(&parameters, "fast_period")
                < parameter_usize(&parameters, "slow_period"),
            "indicator {} requires fast_period < slow_period",
            definition.id
        ),
        IndicatorKind::ParabolicSar => ensure!(
            parameters["step"].as_f64().unwrap() <= parameters["max_step"].as_f64().unwrap(),
            "indicator {} requires step <= max_step",
            definition.id
        ),
        IndicatorKind::VwapAnchoredVwap => {
            let anchor = parameters["anchor"].as_str().unwrap();
            if matches!(anchor, "user_date" | "signal_date") {
                ensure!(
                    parameters.contains_key("anchor_date"),
                    "indicator {} requires anchor_date for {anchor} anchor",
                    definition.id
                );
            } else {
                ensure!(
                    !parameters.contains_key("anchor_date"),
                    "indicator {} only accepts anchor_date for user_date or signal_date anchor",
                    definition.id
                );
            }
        }
        _ => {}
    }
    let mut targets = definition
        .instrument_keys
        .clone()
        .unwrap_or_else(|| instrument_keys.iter().cloned().collect());
    ensure!(
        !targets.is_empty(),
        "indicator {} has no target instruments",
        definition.id
    );
    let original_count = targets.len();
    targets.sort();
    targets.dedup();
    ensure!(
        targets.len() == original_count,
        "indicator {} instrument_keys must not contain duplicates",
        definition.id
    );
    ensure!(
        targets.iter().all(|key| instrument_keys.contains(key)),
        "indicator {} references an unknown target instrument",
        definition.id
    );
    if definition.kind == IndicatorKind::VolumeProfile {
        ensure!(
            definition.instrument_keys.is_some() && targets.len() == 1,
            "indicator {} volume_profile requires exactly one explicit target instrument",
            definition.id
        );
    }
    Ok(ValidatedIndicatorDefinition {
        id: definition.id.clone(),
        kind: definition.kind,
        required_observations: required_observations(definition.kind, &parameters),
        parameters,
        instrument_keys: targets,
    })
}

fn validate_request(
    request: &TechnicalAnalysisRequest,
) -> Result<Vec<ValidatedIndicatorDefinition>> {
    ensure!(
        request.schema_version == TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION,
        "unsupported technical analysis request schema version: {}",
        request.schema_version
    );
    ensure!(
        (1..=MAX_INSTRUMENTS).contains(&request.instruments.len()),
        "technical analysis instruments must contain 1..={MAX_INSTRUMENTS} items"
    );
    ensure!(
        (1..=MAX_INDICATOR_DEFINITIONS).contains(&request.indicators.len()),
        "technical analysis indicators must contain 1..={MAX_INDICATOR_DEFINITIONS} items"
    );
    let mut keys = BTreeSet::new();
    let mut total_bars = 0_usize;
    for instrument in &request.instruments {
        non_empty_bounded(&instrument.key, 128, "instrument key")?;
        non_empty_bounded(&instrument.symbol, 64, "instrument symbol")?;
        non_empty_bounded(&instrument.market, 32, "instrument market")?;
        non_empty_bounded(&instrument.currency, 16, "instrument currency")?;
        ensure!(
            keys.insert(instrument.key.clone()),
            "instrument keys must be unique"
        );
        ensure!(
            (1..=MAX_BARS_PER_INSTRUMENT).contains(&instrument.bars.len()),
            "instrument {} bars must contain 1..={MAX_BARS_PER_INSTRUMENT} items",
            instrument.key
        );
        total_bars = total_bars
            .checked_add(instrument.bars.len())
            .context("technical analysis total bar count overflow")?;
        ensure!(
            total_bars <= MAX_TOTAL_BARS,
            "technical analysis total bars exceed {MAX_TOTAL_BARS}"
        );
        let mut previous = None;
        for bar in &instrument.bars {
            validate_bar(bar, previous, &instrument.key)?;
            previous = Some(bar.date.as_str());
        }
    }
    let mut definition_ids = BTreeSet::new();
    let mut normalized = Vec::with_capacity(request.indicators.len());
    for definition in &request.indicators {
        ensure!(
            definition_ids.insert(definition.id.clone()),
            "indicator ids must be unique"
        );
        normalized.push(normalize_definition(definition, &keys)?);
    }
    let profile_count = normalized
        .iter()
        .filter(|definition| definition.kind == IndicatorKind::VolumeProfile)
        .count();
    ensure!(
        profile_count <= 1,
        "technical analysis accepts at most one volume_profile definition"
    );
    if profile_count == 1 {
        ensure!(
            request.instruments.len() == 1,
            "volume_profile requires a focused request with exactly one instrument"
        );
        ensure!(
            request.indicators.len() == 1,
            "volume_profile focused requests accept exactly one indicator definition"
        );
        ensure!(
            request.instruments[0].bars.len() <= MAX_VOLUME_PROFILE_OBSERVATIONS,
            "volume_profile response is limited to {MAX_VOLUME_PROFILE_OBSERVATIONS} observations"
        );
        let buckets = normalized
            .iter()
            .find(|definition| definition.kind == IndicatorKind::VolumeProfile)
            .map(|definition| parameter_usize(&definition.parameters, "bucket_count"))
            .unwrap();
        ensure!(
            buckets <= MAX_VOLUME_PROFILE_BUCKETS,
            "volume_profile response exceeds the {MAX_VOLUME_PROFILE_BUCKETS} bucket limit"
        );
    }
    normalized.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(normalized)
}

fn null_values(kind: IndicatorKind) -> BTreeMap<String, Option<f64>> {
    catalog_entry(kind)
        .output_fields
        .into_iter()
        .map(|field| (field, None))
        .collect()
}

fn placeholder_point(
    bar: &OhlcvBar,
    index: usize,
    required_observations: usize,
    kind: IndicatorKind,
) -> IndicatorPoint {
    IndicatorPoint {
        date: bar.date.clone(),
        state: if index + 1 < required_observations {
            PointState::Warmup
        } else {
            PointState::Unavailable
        },
        values: null_values(kind),
    }
}

#[derive(Debug)]
struct ComputedSeries {
    points: Vec<IndicatorPoint>,
    observed_observations: usize,
    insufficient_reason: &'static str,
}

fn price_indicator_supported(kind: IndicatorKind) -> bool {
    matches!(
        kind,
        IndicatorKind::Sma
            | IndicatorKind::Ema
            | IndicatorKind::Rsi
            | IndicatorKind::Macd
            | IndicatorKind::BollingerBands
            | IndicatorKind::Atr
            | IndicatorKind::DonchianChannel
            | IndicatorKind::BenchmarkRelativeStrength
            | IndicatorKind::FiftyTwoWeekHighLowPosition
            | IndicatorKind::MovingAverageDistance
            | IndicatorKind::AdxDmi
            | IndicatorKind::StochasticOscillator
            | IndicatorKind::Roc
            | IndicatorKind::KeltnerChannel
            | IndicatorKind::Supertrend
            | IndicatorKind::HistoricalVolatility
            | IndicatorKind::NormalizedAtr
            | IndicatorKind::BollingerBandWidthPercentB
            | IndicatorKind::Aroon
            | IndicatorKind::Cci
            | IndicatorKind::WilliamsR
            | IndicatorKind::ParabolicSar
            | IndicatorKind::ChoppinessIndex
    )
}

fn volume_indicator_supported(kind: IndicatorKind) -> bool {
    matches!(
        kind,
        IndicatorKind::VolumeSma
            | IndicatorKind::RelativeVolume
            | IndicatorKind::Obv
            | IndicatorKind::Mfi
            | IndicatorKind::Cmf
            | IndicatorKind::AccumulationDistributionLine
            | IndicatorKind::VwapAnchoredVwap
            | IndicatorKind::VolumeProfile
    )
}

fn instrument_supports_volume_indicators(instrument_type: InstrumentType) -> bool {
    matches!(instrument_type, InstrumentType::Stock | InstrumentType::Etf)
}

#[inline]
fn loop_checkpoint(control: Option<&dyn ComputeControl>, index: usize) -> Result<()> {
    if index.is_multiple_of(1_024) {
        checkpoint(control)?;
    }
    Ok(())
}

fn selected_source(
    instrument: &InstrumentSeries,
    parameters: &BTreeMap<String, Value>,
) -> Result<Vec<f64>> {
    let source = parameters
        .get("source")
        .and_then(Value::as_str)
        .context("normalized source parameter is required")?;
    match source {
        "open" => Ok(instrument.bars.iter().map(|bar| bar.open).collect()),
        "high" => Ok(instrument.bars.iter().map(|bar| bar.high).collect()),
        "low" => Ok(instrument.bars.iter().map(|bar| bar.low).collect()),
        "close" => Ok(instrument.bars.iter().map(|bar| bar.close).collect()),
        "typical_price" => primitives::typical_price(
            &instrument
                .bars
                .iter()
                .map(|bar| bar.high)
                .collect::<Vec<_>>(),
            &instrument
                .bars
                .iter()
                .map(|bar| bar.low)
                .collect::<Vec<_>>(),
            &instrument
                .bars
                .iter()
                .map(|bar| bar.close)
                .collect::<Vec<_>>(),
        ),
        _ => unreachable!("catalog validation accepts only declared source values"),
    }
}

fn numeric_values(entries: impl IntoIterator<Item = (&'static str, f64)>) -> BTreeMap<String, f64> {
    entries
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

fn points_from_values(
    instrument: &InstrumentSeries,
    kind: IndicatorKind,
    values: Vec<Option<BTreeMap<String, f64>>>,
    missing_states: Option<&[PointState]>,
) -> Result<Vec<IndicatorPoint>> {
    ensure!(
        values.len() == instrument.bars.len(),
        "computed indicator length must match instrument bars"
    );
    if let Some(states) = missing_states {
        ensure!(
            states.len() == values.len(),
            "computed indicator state length must match values"
        );
    }
    instrument
        .bars
        .iter()
        .zip(values)
        .enumerate()
        .map(|(index, (bar, values))| {
            let mut output = null_values(kind);
            let state = if let Some(values) = values {
                ensure!(
                    values.values().all(|value| value.is_finite()),
                    "indicator calculation produced a non-finite value"
                );
                for (name, value) in values {
                    let target = output.get_mut(&name).with_context(|| {
                        format!("indicator calculation produced unknown output {name}")
                    })?;
                    *target = Some(value);
                }
                missing_states
                    .and_then(|states| states.get(index).copied())
                    .unwrap_or(PointState::Available)
            } else {
                missing_states
                    .and_then(|states| states.get(index).copied())
                    .unwrap_or(PointState::Warmup)
            };
            Ok(IndicatorPoint {
                date: bar.date.clone(),
                state,
                values: output,
            })
        })
        .collect()
}

fn single_output(
    values: Vec<Option<f64>>,
    name: &'static str,
) -> Vec<Option<BTreeMap<String, f64>>> {
    values
        .into_iter()
        .map(|value| value.map(|value| numeric_values([(name, value)])))
        .collect()
}

fn compute_sma(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let values = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let values = single_output(primitives::rolling_mean(&values, period)?, "value");
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_ema(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let values = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let values = single_output(primitives::ema(&values, period)?, "value");
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_rsi(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let source = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let mut gains = Vec::with_capacity(source.len().saturating_sub(1));
    let mut losses = Vec::with_capacity(source.len().saturating_sub(1));
    for window in source.windows(2) {
        let change = window[1] - window[0];
        gains.push(change.max(0.0));
        losses.push((-change).max(0.0));
    }
    let average_gain = primitives::wilder_smoothing(&gains, period)?;
    let average_loss = primitives::wilder_smoothing(&losses, period)?;
    let mut values = vec![None; source.len()];
    for delta_index in 0..gains.len() {
        if let (Some(gain), Some(loss)) = (average_gain[delta_index], average_loss[delta_index]) {
            let rsi = if loss == 0.0 {
                if gain > 0.0 { 100.0 } else { 50.0 }
            } else {
                100.0 - 100.0 / (1.0 + gain / loss)
            };
            values[delta_index + 1] = Some(numeric_values([("value", rsi)]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_macd(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let source = selected_source(instrument, &definition.parameters)?;
    let fast_period = parameter_usize(&definition.parameters, "fast_period");
    let slow_period = parameter_usize(&definition.parameters, "slow_period");
    let signal_period = parameter_usize(&definition.parameters, "signal_period");
    let fast = primitives::ema(&source, fast_period)?;
    let slow = primitives::ema(&source, slow_period)?;
    let mut macd = vec![None; source.len()];
    for index in 0..source.len() {
        if let (Some(fast), Some(slow)) = (fast[index], slow[index]) {
            macd[index] = Some(fast - slow);
        }
    }
    let first_macd = macd.iter().position(Option::is_some);
    let mut values = vec![None; source.len()];
    if let Some(first_macd) = first_macd {
        let macd_values = macd[first_macd..]
            .iter()
            .map(|value| value.expect("EMA validity remains contiguous after its seed"))
            .collect::<Vec<_>>();
        let signals = primitives::ema(&macd_values, signal_period)?;
        for (offset, signal) in signals.into_iter().enumerate() {
            if let Some(signal) = signal {
                let index = first_macd + offset;
                let macd = macd[index].unwrap();
                values[index] = Some(numeric_values([
                    ("macd", macd),
                    ("signal", signal),
                    ("histogram", macd - signal),
                ]));
            }
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_bollinger_bands(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let source = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let multiplier = definition.parameters["stddev_multiplier"].as_f64().unwrap();
    let means = primitives::rolling_mean(&source, period)?;
    let deviations = primitives::rolling_population_stddev(&source, period)?;
    let values = means
        .into_iter()
        .zip(deviations)
        .map(|(mean, deviation)| {
            mean.zip(deviation).map(|(middle, deviation)| {
                numeric_values([
                    ("upper", middle + multiplier * deviation),
                    ("middle", middle),
                    ("lower", middle - multiplier * deviation),
                ])
            })
        })
        .collect();
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_atr(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let high = instrument
        .bars
        .iter()
        .map(|bar| bar.high)
        .collect::<Vec<_>>();
    let low = instrument
        .bars
        .iter()
        .map(|bar| bar.low)
        .collect::<Vec<_>>();
    let close = instrument
        .bars
        .iter()
        .map(|bar| bar.close)
        .collect::<Vec<_>>();
    let period = parameter_usize(&definition.parameters, "period");
    let true_range = primitives::true_range(&high, &low, &close)?;
    let values = single_output(primitives::wilder_smoothing(&true_range, period)?, "atr");
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_donchian(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let high = instrument
        .bars
        .iter()
        .map(|bar| bar.high)
        .collect::<Vec<_>>();
    let low = instrument
        .bars
        .iter()
        .map(|bar| bar.low)
        .collect::<Vec<_>>();
    let period = parameter_usize(&definition.parameters, "period");
    let upper = primitives::rolling_max(&high, period)?;
    let lower = primitives::rolling_min(&low, period)?;
    let values = upper
        .into_iter()
        .zip(lower)
        .map(|(upper, lower)| {
            upper.zip(lower).map(|(upper, lower)| {
                numeric_values([
                    ("upper", upper),
                    ("middle", (upper + lower) / 2.0),
                    ("lower", lower),
                ])
            })
        })
        .collect();
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_benchmark_relative_strength(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    instruments: &BTreeMap<&str, &InstrumentSeries>,
) -> Result<ComputedSeries> {
    let benchmark_key = definition.parameters["benchmark_key"].as_str().unwrap();
    let benchmark = instruments
        .get(benchmark_key)
        .context("validated benchmark instrument must exist")?;
    let benchmark_by_date = benchmark
        .bars
        .iter()
        .map(|bar| (bar.date.as_str(), bar.close))
        .collect::<BTreeMap<_, _>>();
    let mut base_ratio = None;
    let mut common_observations = 0_usize;
    let mut states = vec![PointState::Unavailable; instrument.bars.len()];
    let values = instrument
        .bars
        .iter()
        .enumerate()
        .map(|(index, bar)| {
            let benchmark_close = benchmark_by_date.get(bar.date.as_str()).copied()?;
            common_observations += 1;
            let ratio = bar.close / benchmark_close;
            let base = *base_ratio.get_or_insert(ratio);
            states[index] = PointState::Available;
            Some(numeric_values([(
                "relative_strength",
                ratio / base * 100.0,
            )]))
        })
        .collect();
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, Some(&states))?,
        observed_observations: common_observations,
        insufficient_reason: "no_common_benchmark_observation",
    })
}

fn compute_fifty_two_week_position(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let high = instrument
        .bars
        .iter()
        .map(|bar| bar.high)
        .collect::<Vec<_>>();
    let low = instrument
        .bars
        .iter()
        .map(|bar| bar.low)
        .collect::<Vec<_>>();
    let period = parameter_usize(&definition.parameters, "period");
    let rolling_high = primitives::rolling_max(&high, period)?;
    let rolling_low = primitives::rolling_min(&low, period)?;
    let values = rolling_high
        .into_iter()
        .zip(rolling_low)
        .enumerate()
        .map(|(index, (high, low))| {
            high.zip(low).map(|(high, low)| {
                let position = if high == low {
                    50.0
                } else {
                    (instrument.bars[index].close - low) / (high - low) * 100.0
                };
                numeric_values([
                    ("rolling_high", high),
                    ("rolling_low", low),
                    ("position_percent", position),
                ])
            })
        })
        .collect();
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_moving_average_distance(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
) -> Result<ComputedSeries> {
    let source = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let averages = match definition.parameters["average_type"].as_str().unwrap() {
        "sma" => primitives::rolling_mean(&source, period)?,
        "ema" => primitives::ema(&source, period)?,
        _ => unreachable!("catalog validation accepts only SMA or EMA"),
    };
    let values = averages
        .into_iter()
        .zip(source)
        .map(|(average, source)| {
            average.map(|average| {
                numeric_values([
                    ("moving_average", average),
                    ("distance_percent", 100.0 * (source / average - 1.0)),
                ])
            })
        })
        .collect();
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn ohlc_columns(instrument: &InstrumentSeries) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let high = instrument.bars.iter().map(|bar| bar.high).collect();
    let low = instrument.bars.iter().map(|bar| bar.low).collect();
    let close = instrument.bars.iter().map(|bar| bar.close).collect();
    (high, low, close)
}

fn compute_adx_dmi(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let period = parameter_usize(&definition.parameters, "period");
    let mut true_ranges = Vec::with_capacity(instrument.bars.len().saturating_sub(1));
    let mut plus_movements = Vec::with_capacity(true_ranges.capacity());
    let mut minus_movements = Vec::with_capacity(true_ranges.capacity());
    for index in 1..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        let upward = high[index] - high[index - 1];
        let downward = low[index - 1] - low[index];
        plus_movements.push(if upward > downward && upward > 0.0 {
            upward
        } else {
            0.0
        });
        minus_movements.push(if downward > upward && downward > 0.0 {
            downward
        } else {
            0.0
        });
        true_ranges.push(
            (high[index] - low[index])
                .max((high[index] - close[index - 1]).abs())
                .max((low[index] - close[index - 1]).abs()),
        );
    }

    let smoothed_true_range = primitives::wilder_smoothing(&true_ranges, period)?;
    let smoothed_plus = primitives::wilder_smoothing(&plus_movements, period)?;
    let smoothed_minus = primitives::wilder_smoothing(&minus_movements, period)?;
    let mut directional = vec![None; true_ranges.len()];
    let mut dx = vec![None; true_ranges.len()];
    for index in 0..true_ranges.len() {
        loop_checkpoint(control, index)?;
        if let (Some(smoothed_true_range), Some(smoothed_plus), Some(smoothed_minus)) = (
            smoothed_true_range[index],
            smoothed_plus[index],
            smoothed_minus[index],
        ) {
            let (plus_di, minus_di) = if smoothed_true_range == 0.0 {
                (0.0, 0.0)
            } else {
                (
                    100.0 * smoothed_plus / smoothed_true_range,
                    100.0 * smoothed_minus / smoothed_true_range,
                )
            };
            let denominator = plus_di + minus_di;
            directional[index] = Some((plus_di, minus_di));
            dx[index] = Some(if denominator == 0.0 {
                0.0
            } else {
                100.0 * (plus_di - minus_di).abs() / denominator
            });
        }
    }

    let mut values = vec![None; instrument.bars.len()];
    if let Some(first_dx) = dx.iter().position(Option::is_some) {
        let contiguous_dx = dx[first_dx..]
            .iter()
            .map(|value| value.expect("DX remains available after the Wilder seed"))
            .collect::<Vec<_>>();
        let adx = primitives::wilder_smoothing(&contiguous_dx, period)?;
        for (offset, adx) in adx.into_iter().enumerate() {
            loop_checkpoint(control, offset)?;
            if let Some(adx) = adx {
                let delta_index = first_dx + offset;
                let bar_index = delta_index + 1;
                let (plus_di, minus_di) =
                    directional[delta_index].expect("directional values accompany every valid DX");
                values[bar_index] = Some(numeric_values([
                    ("adx", adx),
                    ("plus_di", plus_di),
                    ("minus_di", minus_di),
                ]));
            }
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_stochastic_oscillator(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let lookback = parameter_usize(&definition.parameters, "lookback_period");
    let smooth_k = parameter_usize(&definition.parameters, "smooth_k");
    let smooth_d = parameter_usize(&definition.parameters, "smooth_d");
    let rolling_high = primitives::rolling_max(&high, lookback)?;
    let rolling_low = primitives::rolling_min(&low, lookback)?;
    let mut raw_k = Vec::with_capacity(instrument.bars.len().saturating_sub(lookback - 1));
    for index in lookback - 1..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        let highest = rolling_high[index].expect("lookback maximum is available");
        let lowest = rolling_low[index].expect("lookback minimum is available");
        raw_k.push(if highest == lowest {
            50.0
        } else {
            100.0 * (close[index] - lowest) / (highest - lowest)
        });
    }
    let smoothed_k = primitives::rolling_mean(&raw_k, smooth_k)?;
    let mut values = vec![None; instrument.bars.len()];
    if smoothed_k.len() >= smooth_k {
        let first_smoothed_k = smooth_k - 1;
        let valid_smoothed_k = smoothed_k[first_smoothed_k..]
            .iter()
            .map(|value| value.expect("smoothed %K remains contiguous after warm-up"))
            .collect::<Vec<_>>();
        let smoothed_d = primitives::rolling_mean(&valid_smoothed_k, smooth_d)?;
        for (offset, percent_d) in smoothed_d.into_iter().enumerate() {
            loop_checkpoint(control, offset)?;
            if let Some(percent_d) = percent_d {
                let smoothed_k_index = first_smoothed_k + offset;
                let bar_index = lookback - 1 + smoothed_k_index;
                values[bar_index] = Some(numeric_values([
                    (
                        "percent_k",
                        smoothed_k[smoothed_k_index].expect("%D is only valid for a valid %K"),
                    ),
                    ("percent_d", percent_d),
                ]));
            }
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_roc(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let source = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let mut values = vec![None; source.len()];
    for index in period..source.len() {
        loop_checkpoint(control, index)?;
        values[index] = Some(numeric_values([(
            "value",
            100.0 * (source[index] / source[index - period] - 1.0),
        )]));
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_keltner_channel(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let ema_period = parameter_usize(&definition.parameters, "ema_period");
    let atr_period = parameter_usize(&definition.parameters, "atr_period");
    let multiplier = definition.parameters["multiplier"].as_f64().unwrap();
    let middle = primitives::ema(&close, ema_period)?;
    let true_range = primitives::true_range(&high, &low, &close)?;
    let atr = primitives::wilder_smoothing(&true_range, atr_period)?;
    let mut values = vec![None; instrument.bars.len()];
    for (index, value) in values.iter_mut().enumerate() {
        loop_checkpoint(control, index)?;
        if let (Some(middle), Some(atr)) = (middle[index], atr[index]) {
            *value = Some(numeric_values([
                ("upper", middle + multiplier * atr),
                ("middle", middle),
                ("lower", middle - multiplier * atr),
            ]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_supertrend(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let period = parameter_usize(&definition.parameters, "atr_period");
    let multiplier = definition.parameters["multiplier"].as_f64().unwrap();
    let true_range = primitives::true_range(&high, &low, &close)?;
    let atr = primitives::wilder_smoothing(&true_range, period)?;
    let mut values = vec![None; instrument.bars.len()];
    let Some(first) = atr.iter().position(Option::is_some) else {
        return Ok(ComputedSeries {
            points: points_from_values(instrument, definition.kind, values, None)?,
            observed_observations: instrument.bars.len(),
            insufficient_reason: "warmup_not_met",
        });
    };

    let midpoint = (high[first] + low[first]) / 2.0;
    let first_atr = atr[first].expect("first ATR position is available");
    let mut final_upper = midpoint + multiplier * first_atr;
    let mut final_lower = midpoint - multiplier * first_atr;
    // The first ATR-ready bar starts in a downtrend. Direction is +1 for bullish
    // and -1 for bearish throughout the engine.
    let mut direction = -1.0;
    values[first] = Some(numeric_values([
        ("supertrend", final_upper),
        ("direction", direction),
    ]));

    for index in first + 1..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        let current_atr = atr[index].expect("ATR remains contiguous after its seed");
        let midpoint = (high[index] + low[index]) / 2.0;
        let basic_upper = midpoint + multiplier * current_atr;
        let basic_lower = midpoint - multiplier * current_atr;
        if basic_upper < final_upper || close[index - 1] > final_upper {
            final_upper = basic_upper;
        }
        if basic_lower > final_lower || close[index - 1] < final_lower {
            final_lower = basic_lower;
        }
        if direction < 0.0 {
            if close[index] > final_upper {
                direction = 1.0;
            }
        } else if close[index] < final_lower {
            direction = -1.0;
        }
        let supertrend = if direction > 0.0 {
            final_lower
        } else {
            final_upper
        };
        values[index] = Some(numeric_values([
            ("supertrend", supertrend),
            ("direction", direction),
        ]));
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_historical_volatility(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let close = instrument
        .bars
        .iter()
        .map(|bar| bar.close)
        .collect::<Vec<_>>();
    let period = parameter_usize(&definition.parameters, "period");
    let annualization = parameter_usize(&definition.parameters, "annualization") as f64;
    let return_type = definition.parameters["return_type"].as_str().unwrap();
    let mut returns = Vec::with_capacity(close.len().saturating_sub(1));
    for index in 1..close.len() {
        loop_checkpoint(control, index)?;
        let ratio = close[index] / close[index - 1];
        returns.push(match return_type {
            "simple" => ratio - 1.0,
            "log" => ratio.ln(),
            _ => unreachable!("catalog validation accepts only simple or log returns"),
        });
    }
    let deviations = primitives::rolling_population_stddev(&returns, period)?;
    let mut values = vec![None; instrument.bars.len()];
    for (return_index, deviation) in deviations.into_iter().enumerate() {
        loop_checkpoint(control, return_index)?;
        if let Some(deviation) = deviation {
            values[return_index + 1] = Some(numeric_values([(
                "value",
                100.0 * deviation * annualization.sqrt(),
            )]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_normalized_atr(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let period = parameter_usize(&definition.parameters, "period");
    let true_range = primitives::true_range(&high, &low, &close)?;
    let atr = primitives::wilder_smoothing(&true_range, period)?;
    let mut values = vec![None; instrument.bars.len()];
    for (index, value) in values.iter_mut().enumerate() {
        loop_checkpoint(control, index)?;
        if let Some(atr) = atr[index] {
            *value = Some(numeric_values([("value", 100.0 * atr / close[index])]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_bollinger_band_width_percent_b(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let source = selected_source(instrument, &definition.parameters)?;
    let period = parameter_usize(&definition.parameters, "period");
    let multiplier = definition.parameters["stddev_multiplier"].as_f64().unwrap();
    let middle = primitives::rolling_mean(&source, period)?;
    let deviation = primitives::rolling_population_stddev(&source, period)?;
    let mut values = vec![None; source.len()];
    for index in 0..source.len() {
        loop_checkpoint(control, index)?;
        if let (Some(middle), Some(deviation)) = (middle[index], deviation[index]) {
            let upper = middle + multiplier * deviation;
            let lower = middle - multiplier * deviation;
            let width = upper - lower;
            let percent_b = if width == 0.0 {
                0.5
            } else {
                (source[index] - lower) / width
            };
            values[index] = Some(numeric_values([
                ("bandwidth", 100.0 * width / middle),
                ("percent_b", percent_b),
                ("upper", upper),
                ("middle", middle),
                ("lower", lower),
            ]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_aroon(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let period = parameter_usize(&definition.parameters, "period");
    let window = period + 1;
    let mut high_positions = VecDeque::<usize>::new();
    let mut low_positions = VecDeque::<usize>::new();
    let mut values = vec![None; instrument.bars.len()];
    for (index, value) in values.iter_mut().enumerate() {
        loop_checkpoint(control, index)?;
        while high_positions
            .front()
            .is_some_and(|position| *position + window <= index)
        {
            high_positions.pop_front();
        }
        while low_positions
            .front()
            .is_some_and(|position| *position + window <= index)
        {
            low_positions.pop_front();
        }
        while high_positions
            .back()
            .is_some_and(|position| instrument.bars[*position].high <= instrument.bars[index].high)
        {
            high_positions.pop_back();
        }
        while low_positions
            .back()
            .is_some_and(|position| instrument.bars[*position].low >= instrument.bars[index].low)
        {
            low_positions.pop_back();
        }
        high_positions.push_back(index);
        low_positions.push_back(index);
        if index + 1 >= window {
            let periods_since_high = index - high_positions[0];
            let periods_since_low = index - low_positions[0];
            let aroon_up = 100.0 * (period - periods_since_high) as f64 / period as f64;
            let aroon_down = 100.0 * (period - periods_since_low) as f64 / period as f64;
            *value = Some(numeric_values([
                ("aroon_up", aroon_up),
                ("aroon_down", aroon_down),
                ("oscillator", aroon_up - aroon_down),
            ]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_cci(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let period = parameter_usize(&definition.parameters, "period");
    let constant = definition.parameters["constant"].as_f64().unwrap();
    let typical = primitives::typical_price(&high, &low, &close)?;
    let means = primitives::rolling_mean(&typical, period)?;
    let deviations = primitives::rolling_mean_absolute_deviation(&typical, period)?;
    let mut values = vec![None; instrument.bars.len()];
    for index in 0..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        if let (Some(mean), Some(deviation)) = (means[index], deviations[index]) {
            let cci = if deviation == 0.0 {
                0.0
            } else {
                (typical[index] - mean) / (constant * deviation)
            };
            values[index] = Some(numeric_values([("value", cci)]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_williams_r(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let period = parameter_usize(&definition.parameters, "period");
    let rolling_high = primitives::rolling_max(&high, period)?;
    let rolling_low = primitives::rolling_min(&low, period)?;
    let mut values = vec![None; instrument.bars.len()];
    for index in 0..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        if let (Some(highest), Some(lowest)) = (rolling_high[index], rolling_low[index]) {
            let value = if highest == lowest {
                -50.0
            } else {
                -100.0 * (highest - close[index]) / (highest - lowest)
            };
            values[index] = Some(numeric_values([("value", value)]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_parabolic_sar(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let step = definition.parameters["step"].as_f64().unwrap();
    let max_step = definition.parameters["max_step"].as_f64().unwrap();
    let mut values = vec![None; instrument.bars.len()];
    if instrument.bars.len() < 2 {
        return Ok(ComputedSeries {
            points: points_from_values(instrument, definition.kind, values, None)?,
            observed_observations: instrument.bars.len(),
            insufficient_reason: "warmup_not_met",
        });
    }

    let first = &instrument.bars[0];
    let second = &instrument.bars[1];
    let mut direction = if second.close >= first.close {
        1.0
    } else {
        -1.0
    };
    let mut sar = if direction > 0.0 {
        first.low.min(second.low)
    } else {
        first.high.max(second.high)
    };
    let mut extreme = if direction > 0.0 {
        first.high.max(second.high)
    } else {
        first.low.min(second.low)
    };
    let mut acceleration = step;
    values[1] = Some(numeric_values([("sar", sar), ("direction", direction)]));

    for (index, value) in values.iter_mut().enumerate().skip(2) {
        loop_checkpoint(control, index)?;
        let bar = &instrument.bars[index];
        let prior = &instrument.bars[index - 1];
        let before_prior = &instrument.bars[index - 2];
        let projected = sar + acceleration * (extreme - sar);
        if direction > 0.0 {
            let candidate = projected.min(prior.low).min(before_prior.low);
            if bar.low < candidate {
                direction = -1.0;
                sar = extreme;
                extreme = bar.low;
                acceleration = step;
            } else {
                sar = candidate;
                if bar.high > extreme {
                    extreme = bar.high;
                    acceleration = (acceleration + step).min(max_step);
                }
            }
        } else {
            let candidate = projected.max(prior.high).max(before_prior.high);
            if bar.high > candidate {
                direction = 1.0;
                sar = extreme;
                extreme = bar.high;
                acceleration = step;
            } else {
                sar = candidate;
                if bar.low < extreme {
                    extreme = bar.low;
                    acceleration = (acceleration + step).min(max_step);
                }
            }
        }
        *value = Some(numeric_values([("sar", sar), ("direction", direction)]));
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

fn compute_choppiness_index(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    let (high, low, close) = ohlc_columns(instrument);
    let period = parameter_usize(&definition.parameters, "period");
    let true_range = primitives::true_range(&high, &low, &close)?;
    let range_sum = primitives::rolling_sum(&true_range, period)?;
    let rolling_high = primitives::rolling_max(&high, period)?;
    let rolling_low = primitives::rolling_min(&low, period)?;
    let mut values = vec![None; instrument.bars.len()];
    for index in 0..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        if let (Some(range_sum), Some(highest), Some(lowest)) =
            (range_sum[index], rolling_high[index], rolling_low[index])
        {
            let price_range = highest - lowest;
            let value = if period == 1 || price_range == 0.0 || range_sum == 0.0 {
                50.0
            } else {
                100.0 * (range_sum / price_range).log10() / (period as f64).log10()
            };
            values[index] = Some(numeric_values([("value", value)]));
        }
    }
    Ok(ComputedSeries {
        points: points_from_values(instrument, definition.kind, values, None)?,
        observed_observations: instrument.bars.len(),
        insufficient_reason: "warmup_not_met",
    })
}

#[derive(Debug)]
struct ComputedVolumeSeries {
    points: Vec<IndicatorPoint>,
    observed_observations: usize,
    missing_observations: usize,
    metadata: BTreeMap<String, Value>,
    profile: Option<VolumeProfileResult>,
}

fn volume_columns(instrument: &InstrumentSeries) -> Vec<Option<f64>> {
    instrument.bars.iter().map(|bar| bar.volume).collect()
}

fn rolling_optional_sum(
    values: &[Option<f64>],
    period: usize,
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Option<f64>>> {
    let mut output = vec![None; values.len()];
    let mut sum = 0.0;
    let mut missing = 0_usize;
    for (index, value) in values.iter().copied().enumerate() {
        loop_checkpoint(control, index)?;
        match value {
            Some(value) => sum += value,
            None => missing += 1,
        }
        if index >= period {
            match values[index - period] {
                Some(value) => sum -= value,
                None => missing -= 1,
            }
        }
        if index + 1 >= period && missing == 0 {
            output[index] = Some(sum);
        }
    }
    Ok(output)
}

fn rolling_volume_states(values: &[Option<f64>], period: usize) -> Vec<PointState> {
    let mut states = vec![PointState::Warmup; values.len()];
    let mut missing = 0_usize;
    for (index, value) in values.iter().enumerate() {
        if value.is_none() {
            missing += 1;
        }
        if index >= period && values[index - period].is_none() {
            missing -= 1;
        }
        if index + 1 >= period {
            states[index] = if missing == 0 {
                PointState::Available
            } else {
                PointState::Unavailable
            };
        }
    }
    states
}

fn volume_computation(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    values: Vec<Option<BTreeMap<String, f64>>>,
    states: &[PointState],
) -> Result<ComputedVolumeSeries> {
    let observed_observations = instrument
        .bars
        .iter()
        .filter(|bar| bar.volume.is_some())
        .count();
    Ok(ComputedVolumeSeries {
        points: points_from_values(instrument, definition.kind, values, Some(states))?,
        observed_observations,
        missing_observations: instrument.bars.len() - observed_observations,
        metadata: BTreeMap::new(),
        profile: None,
    })
}

fn compute_volume_sma(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let period = parameter_usize(&definition.parameters, "period");
    let volume = volume_columns(instrument);
    let states = rolling_volume_states(&volume, period);
    let values = rolling_optional_sum(&volume, period, control)?
        .into_iter()
        .map(|value| value.map(|sum| numeric_values([("value", sum / period as f64)])))
        .collect();
    volume_computation(instrument, definition, values, &states)
}

fn compute_relative_volume(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let period = parameter_usize(&definition.parameters, "period");
    let volume = volume_columns(instrument);
    let rolling_sum = rolling_optional_sum(&volume, period, control)?;
    let mut values = vec![None; instrument.bars.len()];
    let mut states = vec![PointState::Warmup; instrument.bars.len()];
    for index in period..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        match (volume[index], rolling_sum[index - 1]) {
            (Some(current), Some(prior_sum)) => {
                let prior_average = prior_sum / period as f64;
                if prior_average == 0.0 && current > 0.0 {
                    states[index] = PointState::Unavailable;
                } else {
                    let relative = if prior_average == 0.0 {
                        0.0
                    } else {
                        current / prior_average
                    };
                    values[index] = Some(numeric_values([("value", relative)]));
                    states[index] = PointState::Available;
                }
            }
            _ => states[index] = PointState::Unavailable,
        }
    }
    volume_computation(instrument, definition, values, &states)
}

fn compute_obv(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let volume = volume_columns(instrument);
    let mut values = vec![None; instrument.bars.len()];
    let mut states = vec![PointState::Unavailable; instrument.bars.len()];
    let mut segment_started = false;
    let mut obv = 0.0;
    for (index, current_volume) in volume.iter().copied().enumerate() {
        loop_checkpoint(control, index)?;
        let Some(current_volume) = current_volume else {
            segment_started = false;
            continue;
        };
        if !segment_started {
            obv = 0.0;
            segment_started = true;
        } else if instrument.bars[index].close > instrument.bars[index - 1].close {
            obv += current_volume;
        } else if instrument.bars[index].close < instrument.bars[index - 1].close {
            obv -= current_volume;
        }
        values[index] = Some(numeric_values([("value", obv)]));
        states[index] = PointState::Available;
    }
    volume_computation(instrument, definition, values, &states)
}

fn compute_mfi(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let period = parameter_usize(&definition.parameters, "period");
    let (high, low, close) = ohlc_columns(instrument);
    let typical_price = primitives::typical_price(&high, &low, &close)?;
    let volume = volume_columns(instrument);
    let mut raw_flows = vec![None; instrument.bars.len()];
    for index in 1..instrument.bars.len() {
        raw_flows[index] = volume[index].map(|volume| {
            let flow = typical_price[index] * volume;
            if typical_price[index] > typical_price[index - 1] {
                (flow, 0.0)
            } else if typical_price[index] < typical_price[index - 1] {
                (0.0, flow)
            } else {
                (0.0, 0.0)
            }
        });
    }

    let mut values = vec![None; instrument.bars.len()];
    let mut states = vec![PointState::Warmup; instrument.bars.len()];
    let mut positive_sum = 0.0;
    let mut negative_sum = 0.0;
    let mut missing = 0_usize;
    for index in 1..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        match raw_flows[index] {
            Some((positive, negative)) => {
                positive_sum += positive;
                negative_sum += negative;
            }
            None => missing += 1,
        }
        if index > period {
            match raw_flows[index - period] {
                Some((positive, negative)) => {
                    positive_sum -= positive;
                    negative_sum -= negative;
                }
                None => missing -= 1,
            }
        }
        if index >= period {
            if missing == 0 {
                let value = if negative_sum == 0.0 {
                    if positive_sum == 0.0 { 50.0 } else { 100.0 }
                } else {
                    100.0 - 100.0 / (1.0 + positive_sum / negative_sum)
                };
                values[index] = Some(numeric_values([("value", value)]));
                states[index] = PointState::Available;
            } else {
                states[index] = PointState::Unavailable;
            }
        }
    }
    volume_computation(instrument, definition, values, &states)
}

fn money_flow_multiplier(bar: &OhlcvBar) -> f64 {
    let range = bar.high - bar.low;
    if range == 0.0 {
        0.0
    } else {
        ((bar.close - bar.low) - (bar.high - bar.close)) / range
    }
}

fn compute_cmf(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let period = parameter_usize(&definition.parameters, "period");
    let volume = volume_columns(instrument);
    let states = rolling_volume_states(&volume, period);
    let money_flow_volume = instrument
        .bars
        .iter()
        .map(|bar| bar.volume.map(|volume| money_flow_multiplier(bar) * volume))
        .collect::<Vec<_>>();
    let volume_sum = rolling_optional_sum(&volume, period, control)?;
    let money_flow_sum = rolling_optional_sum(&money_flow_volume, period, control)?;
    let values = volume_sum
        .into_iter()
        .zip(money_flow_sum)
        .map(|(volume, money_flow)| match (volume, money_flow) {
            (Some(volume), Some(money_flow)) => Some(numeric_values([(
                "value",
                if volume == 0.0 {
                    0.0
                } else {
                    money_flow / volume
                },
            )])),
            _ => None,
        })
        .collect();
    volume_computation(instrument, definition, values, &states)
}

fn compute_accumulation_distribution_line(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let mut values = vec![None; instrument.bars.len()];
    let mut states = vec![PointState::Unavailable; instrument.bars.len()];
    let mut segment_started = false;
    let mut cumulative = 0.0;
    for (index, bar) in instrument.bars.iter().enumerate() {
        loop_checkpoint(control, index)?;
        let Some(volume) = bar.volume else {
            segment_started = false;
            continue;
        };
        let money_flow_volume = money_flow_multiplier(bar) * volume;
        if segment_started {
            cumulative += money_flow_volume;
        } else {
            cumulative = money_flow_volume;
            segment_started = true;
        }
        values[index] = Some(numeric_values([("value", cumulative)]));
        states[index] = PointState::Available;
    }
    volume_computation(instrument, definition, values, &states)
}

fn cumulative_vwap_at(
    weighted_prefix: &[f64],
    volume_prefix: &[f64],
    missing_prefix: &[usize],
    start: usize,
    end: usize,
) -> Option<f64> {
    if start > end || missing_prefix[end + 1] != missing_prefix[start] {
        return None;
    }
    let volume = volume_prefix[end + 1] - volume_prefix[start];
    if volume <= 0.0 {
        return None;
    }
    Some((weighted_prefix[end + 1] - weighted_prefix[start]) / volume)
}

fn causal_recent_anchor_indices(
    instrument: &InstrumentSeries,
    lookback: usize,
    high_anchor: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Option<usize>>> {
    let mut anchors = vec![None; instrument.bars.len()];
    let mut extrema = VecDeque::<usize>::new();
    for (index, anchor) in anchors.iter_mut().enumerate() {
        loop_checkpoint(control, index)?;
        let window_start = (index + 1).saturating_sub(lookback);
        while extrema
            .front()
            .is_some_and(|candidate| *candidate < window_start)
        {
            extrema.pop_front();
        }
        while extrema.back().is_some_and(|candidate| {
            let previous = &instrument.bars[*candidate];
            let current = &instrument.bars[index];
            if high_anchor {
                previous.high <= current.high
            } else {
                previous.low >= current.low
            }
        }) {
            extrema.pop_back();
        }
        extrema.push_back(index);
        if index + 1 >= lookback {
            *anchor = extrema.front().copied();
        }
    }
    Ok(anchors)
}

fn compute_vwap_anchored_vwap(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let mode = definition.parameters["mode"].as_str().unwrap();
    let anchor = definition.parameters["anchor"].as_str().unwrap();
    let lookback = parameter_usize(&definition.parameters, "lookback_period");
    let (high, low, close) = ohlc_columns(instrument);
    let prices = primitives::typical_price(&high, &low, &close)?;
    let mut weighted_prefix = vec![0.0; instrument.bars.len() + 1];
    let mut volume_prefix = vec![0.0; instrument.bars.len() + 1];
    let mut missing_prefix = vec![0_usize; instrument.bars.len() + 1];
    for (index, (price, bar)) in prices.iter().zip(&instrument.bars).enumerate() {
        loop_checkpoint(control, index)?;
        weighted_prefix[index + 1] = weighted_prefix[index];
        volume_prefix[index + 1] = volume_prefix[index];
        missing_prefix[index + 1] = missing_prefix[index];
        if let Some(volume) = bar.volume {
            let weighted = price * volume;
            ensure!(
                weighted.is_finite(),
                "VWAP price-times-volume overflow at {}",
                bar.date
            );
            weighted_prefix[index + 1] += weighted;
            volume_prefix[index + 1] += volume;
            ensure!(
                weighted_prefix[index + 1].is_finite() && volume_prefix[index + 1].is_finite(),
                "VWAP cumulative sum overflow at {}",
                bar.date
            );
        } else {
            missing_prefix[index + 1] += 1;
        }
    }

    let requested_anchor_date = definition
        .parameters
        .get("anchor_date")
        .and_then(Value::as_str);
    let static_anchor = match anchor {
        "period_start" => Some(0),
        "user_date" | "signal_date" => requested_anchor_date.and_then(|date| {
            instrument
                .bars
                .iter()
                .position(|bar| bar.date.as_str() >= date)
        }),
        "recent_high" | "recent_low" => None,
        _ => unreachable!("catalog validation accepts only declared anchor modes"),
    };
    let dynamic_anchors = match anchor {
        "recent_high" => Some(causal_recent_anchor_indices(
            instrument, lookback, true, control,
        )?),
        "recent_low" => Some(causal_recent_anchor_indices(
            instrument, lookback, false, control,
        )?),
        _ => None,
    };

    let mut values = vec![None; instrument.bars.len()];
    let mut states = vec![PointState::Unavailable; instrument.bars.len()];
    for index in 0..instrument.bars.len() {
        loop_checkpoint(control, index)?;
        let standard = if mode != "anchored" {
            cumulative_vwap_at(&weighted_prefix, &volume_prefix, &missing_prefix, 0, index)
        } else {
            None
        };
        let anchor_index = dynamic_anchors
            .as_ref()
            .and_then(|anchors| anchors[index])
            .or(static_anchor);
        let anchored = if mode != "vwap" {
            anchor_index.and_then(|start| {
                cumulative_vwap_at(
                    &weighted_prefix,
                    &volume_prefix,
                    &missing_prefix,
                    start,
                    index,
                )
            })
        } else {
            None
        };
        let mut row = BTreeMap::new();
        if let Some(value) = standard {
            row.insert("vwap".to_owned(), value);
        }
        if let Some(value) = anchored {
            row.insert("anchored_vwap".to_owned(), value);
        }
        let all_requested_fields_ready = match mode {
            "vwap" => standard.is_some(),
            "anchored" => anchored.is_some(),
            "both" => standard.is_some() && anchored.is_some(),
            _ => unreachable!("catalog validation accepts only declared VWAP modes"),
        };
        states[index] = if all_requested_fields_ready {
            PointState::Available
        } else if index + 1 < definition.required_observations {
            PointState::Warmup
        } else {
            PointState::Unavailable
        };
        if !row.is_empty() {
            values[index] = Some(row);
        }
    }

    let latest_dynamic_anchor = dynamic_anchors
        .as_ref()
        .and_then(|anchors| anchors.last().copied().flatten());
    let resolved_anchor = latest_dynamic_anchor
        .or(static_anchor)
        .and_then(|index| instrument.bars.get(index))
        .map(|bar| bar.date.clone());
    let mut computed = volume_computation(instrument, definition, values, &states)?;
    computed.metadata = BTreeMap::from([
        ("approximate".into(), json!(true)),
        (
            "approximation".into(),
            json!("bar_hlc3_times_bar_volume_not_intrabar_execution_vwap"),
        ),
        ("price_basis".into(), json!("typical_price_hlc3")),
        ("mode".into(), json!(mode)),
        ("anchor".into(), json!(anchor)),
        ("anchor_applied".into(), json!(mode != "vwap")),
        ("requested_anchor_date".into(), json!(requested_anchor_date)),
        ("resolved_anchor_date".into(), json!(resolved_anchor)),
        (
            "anchor_resolution".into(),
            json!(match anchor {
                "period_start" => "first_requested_bar",
                "user_date" | "signal_date" => "first_bar_on_or_after_requested_date",
                "recent_high" => "causal_trailing_high_current_inclusive_most_recent_tie",
                "recent_low" => "causal_trailing_low_current_inclusive_most_recent_tie",
                _ => unreachable!(),
            }),
        ),
        ("lookback_period".into(), json!(lookback)),
        ("future_data_used".into(), json!(false)),
        (
            "missing_volume_policy".into(),
            json!("anchor_range_with_any_missing_volume_is_unavailable"),
        ),
        (
            "zero_volume_policy".into(),
            json!("zero_denominator_is_unavailable_until_positive_cumulative_volume"),
        ),
    ]);
    Ok(computed)
}

fn compute_volume_profile(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    let requested_bucket_count = parameter_usize(&definition.parameters, "bucket_count");
    let price_source = definition.parameters["price_source"].as_str().unwrap();
    let value_area_percent = definition.parameters["value_area_percent"]
        .as_f64()
        .unwrap();
    let (high, low, close) = ohlc_columns(instrument);
    let prices = if price_source == "close" {
        close
    } else {
        primitives::typical_price(&high, &low, &close)?
    };
    let mut observations = Vec::new();
    for (index, (bar, price)) in instrument.bars.iter().zip(prices).enumerate() {
        loop_checkpoint(control, index)?;
        if let Some(volume) = bar.volume {
            observations.push((price, volume));
        }
    }
    let mut values = vec![None; instrument.bars.len()];
    let states = vec![PointState::Unavailable; instrument.bars.len()];
    let mut computed = volume_computation(instrument, definition, values.clone(), &states)?;
    computed.metadata = BTreeMap::from([
        ("approximate".into(), json!(true)),
        (
            "approximation".into(),
            json!("each_bar_full_volume_assigned_to_one_selected_representative_price_bucket"),
        ),
        ("price_source".into(), json!(price_source)),
        ("point_of_control_tie".into(), json!("higher_price_bucket")),
        (
            "value_area_expansion".into(),
            json!("contiguous_from_poc_larger_adjacent_volume_first_ties_higher_until_target_met"),
        ),
        (
            "maximum_bucket_count".into(),
            json!(MAX_VOLUME_PROFILE_BUCKETS),
        ),
        (
            "maximum_observations".into(),
            json!(MAX_VOLUME_PROFILE_OBSERVATIONS),
        ),
    ]);
    if observations.is_empty() {
        computed.metadata.insert(
            "profile_status".into(),
            json!("all_volume_observations_missing"),
        );
        return Ok(computed);
    }
    let total_volume = observations.iter().try_fold(0.0, |total, (_, volume)| {
        let next = total + volume;
        ensure!(next.is_finite(), "volume profile total volume overflow");
        Ok::<_, anyhow::Error>(next)
    })?;
    if total_volume <= 0.0 {
        computed
            .metadata
            .insert("profile_status".into(), json!("zero_total_volume"));
        return Ok(computed);
    }

    let price_min = observations
        .iter()
        .map(|(price, _)| *price)
        .fold(f64::INFINITY, f64::min);
    let price_max = observations
        .iter()
        .map(|(price, _)| *price)
        .fold(f64::NEG_INFINITY, f64::max);
    let effective_bucket_count = if price_min == price_max {
        1
    } else {
        requested_bucket_count
    };
    let bucket_width = if effective_bucket_count == 1 {
        0.0
    } else {
        (price_max - price_min) / effective_bucket_count as f64
    };
    let mut bucket_volumes = vec![0.0; effective_bucket_count];
    for (index, (price, volume)) in observations.iter().copied().enumerate() {
        loop_checkpoint(control, index)?;
        let bucket_index = if effective_bucket_count == 1 || price == price_max {
            effective_bucket_count - 1
        } else {
            (((price - price_min) / bucket_width).floor() as usize).min(effective_bucket_count - 1)
        };
        bucket_volumes[bucket_index] += volume;
        ensure!(
            bucket_volumes[bucket_index].is_finite(),
            "volume profile bucket volume overflow"
        );
    }
    let mut point_of_control_index = 0_usize;
    for index in 1..bucket_volumes.len() {
        if bucket_volumes[index] >= bucket_volumes[point_of_control_index] {
            point_of_control_index = index;
        }
    }
    let target_volume = total_volume * value_area_percent / 100.0;
    let mut value_area_low_index = point_of_control_index;
    let mut value_area_high_index = point_of_control_index;
    let mut value_area_volume = bucket_volumes[point_of_control_index];
    while value_area_volume < target_volume
        && (value_area_low_index > 0 || value_area_high_index + 1 < effective_bucket_count)
    {
        let below = value_area_low_index
            .checked_sub(1)
            .map(|index| (index, bucket_volumes[index]));
        let above = (value_area_high_index + 1 < effective_bucket_count).then(|| {
            let index = value_area_high_index + 1;
            (index, bucket_volumes[index])
        });
        match (below, above) {
            (Some((below_index, below_volume)), Some((above_index, above_volume))) => {
                if above_volume >= below_volume {
                    value_area_high_index = above_index;
                    value_area_volume += above_volume;
                } else {
                    value_area_low_index = below_index;
                    value_area_volume += below_volume;
                }
            }
            (Some((below_index, below_volume)), None) => {
                value_area_low_index = below_index;
                value_area_volume += below_volume;
            }
            (None, Some((above_index, above_volume))) => {
                value_area_high_index = above_index;
                value_area_volume += above_volume;
            }
            (None, None) => break,
        }
    }
    let bounds = |index: usize| {
        if effective_bucket_count == 1 {
            (price_min, price_max)
        } else {
            let low = price_min + bucket_width * index as f64;
            let high = if index + 1 == effective_bucket_count {
                price_max
            } else {
                price_min + bucket_width * (index + 1) as f64
            };
            (low, high)
        }
    };
    let buckets = bucket_volumes
        .iter()
        .enumerate()
        .map(|(index, volume)| {
            let (price_low, price_high) = bounds(index);
            VolumeProfileBucket {
                index,
                price_low,
                price_high,
                price_mid: (price_low + price_high) / 2.0,
                volume: *volume,
                volume_percent: *volume / total_volume * 100.0,
                in_value_area: (value_area_low_index..=value_area_high_index).contains(&index),
                is_point_of_control: index == point_of_control_index,
            }
        })
        .collect::<Vec<_>>();
    let point_of_control = buckets[point_of_control_index].price_mid;
    let value_area_low = buckets[value_area_low_index].price_low;
    let value_area_high = buckets[value_area_high_index].price_high;
    if let Some(last) = values.last_mut() {
        *last = Some(numeric_values([
            ("point_of_control", point_of_control),
            ("value_area_high", value_area_high),
            ("value_area_low", value_area_low),
        ]));
    }
    let mut output_states = vec![PointState::Unavailable; instrument.bars.len()];
    if let Some(last) = output_states.last_mut() {
        *last = PointState::Available;
    }
    computed.points =
        points_from_values(instrument, definition.kind, values, Some(&output_states))?;
    computed.profile = Some(VolumeProfileResult {
        schema_version: "volume-profile/v1".into(),
        from_date: instrument.bars.first().unwrap().date.clone(),
        to_date: instrument.bars.last().unwrap().date.clone(),
        price_source: price_source.into(),
        requested_bucket_count,
        effective_bucket_count,
        price_min,
        price_max,
        bucket_width,
        total_volume,
        included_observations: observations.len(),
        missing_volume_observations: instrument.bars.len() - observations.len(),
        value_area_percent,
        point_of_control,
        value_area_high,
        value_area_low,
        buckets,
        approximation: "each_bar_full_volume_assigned_to_one_selected_representative_price_bucket"
            .into(),
    });
    computed
        .metadata
        .insert("profile_status".into(), json!("calculated"));
    Ok(computed)
}

fn compute_volume_indicator(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedVolumeSeries> {
    match definition.kind {
        IndicatorKind::VolumeSma => compute_volume_sma(instrument, definition, control),
        IndicatorKind::RelativeVolume => compute_relative_volume(instrument, definition, control),
        IndicatorKind::Obv => compute_obv(instrument, definition, control),
        IndicatorKind::Mfi => compute_mfi(instrument, definition, control),
        IndicatorKind::Cmf => compute_cmf(instrument, definition, control),
        IndicatorKind::AccumulationDistributionLine => {
            compute_accumulation_distribution_line(instrument, definition, control)
        }
        IndicatorKind::VwapAnchoredVwap => {
            compute_vwap_anchored_vwap(instrument, definition, control)
        }
        IndicatorKind::VolumeProfile => compute_volume_profile(instrument, definition, control),
        _ => unreachable!("volume-indicator dispatcher receives only implemented kinds"),
    }
}

fn compute_price_indicator(
    instrument: &InstrumentSeries,
    definition: &ValidatedIndicatorDefinition,
    instruments: &BTreeMap<&str, &InstrumentSeries>,
    control: Option<&dyn ComputeControl>,
) -> Result<ComputedSeries> {
    match definition.kind {
        IndicatorKind::Sma => compute_sma(instrument, definition),
        IndicatorKind::Ema => compute_ema(instrument, definition),
        IndicatorKind::Rsi => compute_rsi(instrument, definition),
        IndicatorKind::Macd => compute_macd(instrument, definition),
        IndicatorKind::BollingerBands => compute_bollinger_bands(instrument, definition),
        IndicatorKind::Atr => compute_atr(instrument, definition),
        IndicatorKind::DonchianChannel => compute_donchian(instrument, definition),
        IndicatorKind::BenchmarkRelativeStrength => {
            compute_benchmark_relative_strength(instrument, definition, instruments)
        }
        IndicatorKind::FiftyTwoWeekHighLowPosition => {
            compute_fifty_two_week_position(instrument, definition)
        }
        IndicatorKind::MovingAverageDistance => {
            compute_moving_average_distance(instrument, definition)
        }
        IndicatorKind::AdxDmi => compute_adx_dmi(instrument, definition, control),
        IndicatorKind::StochasticOscillator => {
            compute_stochastic_oscillator(instrument, definition, control)
        }
        IndicatorKind::Roc => compute_roc(instrument, definition, control),
        IndicatorKind::KeltnerChannel => compute_keltner_channel(instrument, definition, control),
        IndicatorKind::Supertrend => compute_supertrend(instrument, definition, control),
        IndicatorKind::HistoricalVolatility => {
            compute_historical_volatility(instrument, definition, control)
        }
        IndicatorKind::NormalizedAtr => compute_normalized_atr(instrument, definition, control),
        IndicatorKind::BollingerBandWidthPercentB => {
            compute_bollinger_band_width_percent_b(instrument, definition, control)
        }
        IndicatorKind::Aroon => compute_aroon(instrument, definition, control),
        IndicatorKind::Cci => compute_cci(instrument, definition, control),
        IndicatorKind::WilliamsR => compute_williams_r(instrument, definition, control),
        IndicatorKind::ParabolicSar => compute_parabolic_sar(instrument, definition, control),
        IndicatorKind::ChoppinessIndex => compute_choppiness_index(instrument, definition, control),
        _ => unreachable!("price-indicator dispatcher receives only implemented kinds"),
    }
}

pub fn analyze(
    request: &TechnicalAnalysisRequest,
    control: Option<&dyn ComputeControl>,
) -> Result<TechnicalAnalysisResult> {
    checkpoint(control)?;
    let definitions = validate_request(request)?;
    let instruments_by_key = request
        .instruments
        .iter()
        .map(|instrument| (instrument.key.as_str(), instrument))
        .collect::<BTreeMap<_, _>>();
    let mut instruments = request.instruments.iter().collect::<Vec<_>>();
    instruments.sort_by(|left, right| left.key.cmp(&right.key));
    let mut calculations = Vec::new();
    for instrument in instruments {
        for definition in &definitions {
            if !definition.instrument_keys.contains(&instrument.key) {
                continue;
            }
            checkpoint(control)?;
            let (full_points, availability, warmup, mut metadata, profile) =
                if price_indicator_supported(definition.kind) {
                    let computed = compute_price_indicator(
                        instrument,
                        definition,
                        &instruments_by_key,
                        control,
                    )?;
                    let first_available_date = computed
                        .points
                        .iter()
                        .find(|point| point.state == PointState::Available)
                        .map(|point| point.date.clone());
                    let available_point_count = computed
                        .points
                        .iter()
                        .filter(|point| point.state == PointState::Available)
                        .count();
                    let availability = if first_available_date.is_none() {
                        Availability {
                            status: AvailabilityStatus::InsufficientHistory,
                            reason: computed.insufficient_reason.into(),
                        }
                    } else if definition.kind == IndicatorKind::BenchmarkRelativeStrength
                        && available_point_count < computed.points.len()
                    {
                        Availability {
                            status: AvailabilityStatus::Partial,
                            reason: "partial_benchmark_date_coverage".into(),
                        }
                    } else {
                        Availability {
                            status: AvailabilityStatus::Available,
                            reason: "calculated".into(),
                        }
                    };
                    let warmup = WarmupMetadata {
                        required_observations: definition.required_observations,
                        observed_observations: computed.observed_observations,
                        state: if first_available_date.is_some() {
                            WarmupState::Ready
                        } else {
                            WarmupState::WarmingUp
                        },
                        first_available_date,
                    };
                    (computed.points, availability, warmup, BTreeMap::new(), None)
                } else if volume_indicator_supported(definition.kind)
                    && instrument_supports_volume_indicators(instrument.instrument_type)
                {
                    let computed = compute_volume_indicator(instrument, definition, control)?;
                    let first_available_date = computed
                        .points
                        .iter()
                        .find(|point| point.state == PointState::Available)
                        .map(|point| point.date.clone());
                    let calculation_gap_count = computed
                        .points
                        .iter()
                        .enumerate()
                        .filter(|(index, point)| {
                            *index + 1 >= definition.required_observations
                                && point.state == PointState::Unavailable
                        })
                        .count();
                    let availability = if computed.observed_observations == 0 {
                        Availability {
                            status: AvailabilityStatus::VolumeUnavailable,
                            reason: "all_volume_observations_missing".into(),
                        }
                    } else if definition.kind == IndicatorKind::VolumeProfile {
                        if computed.profile.is_none() {
                            Availability {
                                status: AvailabilityStatus::Partial,
                                reason: "zero_total_volume".into(),
                            }
                        } else if computed.missing_observations > 0 {
                            Availability {
                                status: AvailabilityStatus::Partial,
                                reason: "partial_volume_coverage".into(),
                            }
                        } else {
                            Availability {
                                status: AvailabilityStatus::Available,
                                reason: "calculated".into(),
                            }
                        }
                    } else if definition.kind == IndicatorKind::VwapAnchoredVwap
                        && definition.parameters["mode"].as_str() != Some("vwap")
                        && matches!(
                            definition.parameters["anchor"].as_str(),
                            Some("user_date" | "signal_date")
                        )
                        && computed
                            .metadata
                            .get("resolved_anchor_date")
                            .is_some_and(Value::is_null)
                    {
                        Availability {
                            status: if definition.parameters["mode"].as_str() == Some("anchored") {
                                AvailabilityStatus::InsufficientHistory
                            } else {
                                AvailabilityStatus::Partial
                            },
                            reason: "anchor_after_last_observation".into(),
                        }
                    } else if first_available_date.is_none()
                        && calculation_gap_count > 0
                        && computed.missing_observations == 0
                    {
                        Availability {
                            status: AvailabilityStatus::Partial,
                            reason: "partial_calculation_coverage".into(),
                        }
                    } else if first_available_date.is_none() {
                        Availability {
                            status: AvailabilityStatus::InsufficientHistory,
                            reason: "complete_volume_window_not_available".into(),
                        }
                    } else if computed.missing_observations > 0 {
                        Availability {
                            status: AvailabilityStatus::Partial,
                            reason: "partial_volume_coverage".into(),
                        }
                    } else if calculation_gap_count > 0 {
                        Availability {
                            status: AvailabilityStatus::Partial,
                            reason: "partial_calculation_coverage".into(),
                        }
                    } else {
                        Availability {
                            status: AvailabilityStatus::Available,
                            reason: "calculated".into(),
                        }
                    };
                    let warmup = WarmupMetadata {
                        required_observations: definition.required_observations,
                        observed_observations: computed.observed_observations,
                        state: if first_available_date.is_some()
                            || (calculation_gap_count > 0
                                && computed.missing_observations == 0
                                && computed.observed_observations
                                    >= definition.required_observations)
                        {
                            WarmupState::Ready
                        } else {
                            WarmupState::WarmingUp
                        },
                        first_available_date,
                    };
                    (
                        computed.points,
                        availability,
                        warmup,
                        computed.metadata,
                        computed.profile,
                    )
                } else {
                    let observed = instrument.bars.len();
                    let observed_volume = instrument
                        .bars
                        .iter()
                        .filter(|bar| bar.volume.is_some())
                        .count();
                    let mut points = Vec::with_capacity(observed);
                    for (index, bar) in instrument.bars.iter().enumerate() {
                        if index.is_multiple_of(1_024) {
                            checkpoint(control)?;
                        }
                        points.push(placeholder_point(
                            bar,
                            index,
                            definition.required_observations,
                            definition.kind,
                        ));
                    }
                    (
                        points,
                        Availability {
                            status: if volume_indicator_supported(definition.kind) {
                                AvailabilityStatus::UnsupportedInstrument
                            } else {
                                AvailabilityStatus::Unavailable
                            },
                            reason: if volume_indicator_supported(definition.kind) {
                                "volume_indicators_support_stock_and_etf_only".into()
                            } else {
                                "indicator_not_implemented".into()
                            },
                        },
                        WarmupMetadata {
                            required_observations: definition.required_observations,
                            observed_observations: if volume_indicator_supported(definition.kind) {
                                observed_volume
                            } else {
                                observed
                            },
                            state: if (if volume_indicator_supported(definition.kind) {
                                observed_volume
                            } else {
                                observed
                            }) < definition.required_observations
                            {
                                WarmupState::WarmingUp
                            } else {
                                WarmupState::Ready
                            },
                            first_available_date: None,
                        },
                        BTreeMap::new(),
                        None,
                    )
                };
            let (points, latest, profile) = match request.response_mode {
                ResponseMode::FullSeries => (Some(full_points), None, profile),
                ResponseMode::LatestSummary => {
                    let mut summary_profile = profile;
                    if let Some(profile) = &mut summary_profile {
                        profile.buckets.clear();
                        metadata
                            .insert("profile_buckets".into(), json!("omitted_in_latest_summary"));
                    }
                    (None, full_points.last().cloned(), summary_profile)
                }
            };
            calculations.push(IndicatorCalculation {
                instrument_key: instrument.key.clone(),
                indicator_id: definition.id.clone(),
                kind: definition.kind,
                parameters: definition.parameters.clone(),
                availability,
                warmup,
                metadata,
                profile,
                points,
                latest,
            });
        }
    }
    calculations.sort_by(|left, right| {
        left.instrument_key
            .cmp(&right.instrument_key)
            .then_with(|| left.indicator_id.cmp(&right.indicator_id))
    });
    let total_bar_count = request.instruments.iter().map(|item| item.bars.len()).sum();
    let diagnostics = TechnicalDiagnostics {
        validation: "passed".into(),
        deterministic_order: "instrument_key_then_indicator_id".into(),
        adjustment_policy: request.adjustment_policy,
        policies: CalculationPolicies {
            ohlc_missing: "reject".into(),
            volume_missing: "preserve_json_null_and_mark_affected_points_unavailable".into(),
            volume_input_unit: "caller_supplied_non_negative_provider_units".into(),
            volume_adjustment:
                "no_worker_adjustment_caller_responsible_for_provider_corporate_action_semantics"
                    .into(),
            volume_currency_conversion: "none".into(),
            date_order: "strict_ascending_unique_iso_dates".into(),
            timeframe: "caller_supplied_bars_no_implicit_resampling".into(),
            warmup: "json_null_until_required_observations".into(),
            unavailable_value: "json_null_with_explicit_state".into(),
            standard_deviation: "population".into(),
            ema_seed: "first_period_sma".into(),
            wilder_seed: "first_period_sma".into(),
            true_range_initial: "high_minus_low".into(),
            numeric_rounding: "full_f64_no_indicator_rounding".into(),
            vwap_price_basis: "bar_typical_price_hlc3_weighted_by_caller_volume".into(),
            vwap_reset: "request_series_start_without_implicit_calendar_session_reset".into(),
            anchored_vwap_anchor: "period_start_or_next_available_static_date_or_causal_trailing_extreme".into(),
            volume_profile_approximation:
                "each_bar_full_volume_assigned_to_one_close_or_hlc3_bucket".into(),
            volume_profile_value_area:
                "contiguous_from_poc_larger_adjacent_volume_first_ties_higher_until_target_met"
                    .into(),
        },
        instrument_count: request.instruments.len(),
        indicator_definition_count: request.indicators.len(),
        calculation_count: calculations.len(),
        total_bar_count,
        catalog: indicator_catalog(),
        messages: vec![
            "stage-4 implements all 31 catalog indicators in the shared Rust engine".into(),
            "OHLC values use the caller-declared adjustment_policy without implicit conversion".into(),
            "population standard deviation, SMA-seeded EMA, and SMA-seeded Wilder smoothing are fixed engine policies".into(),
            "ADX/DMI maps zero smoothed true range and zero DI sum to neutral 0; flat stochastic, Williams %R, CCI, Bollinger %B, and choppiness values are 50, -50, 0, 0.5, and 50 respectively".into(),
            "ROC, normalized ATR, Bollinger bandwidth, and historical volatility are percentage values; Bollinger %B is a unit ratio where 0 is the lower band and 1 is the upper band".into(),
            "historical volatility uses population deviation of caller-selected simple or log returns, multiplied by sqrt(annualization) and 100".into(),
            "ADX/DMI seeds Wilder smoothing from period directional bars and emits ADX after period additional DX values; stochastic windows include the current bar and apply SMA smooth_k then SMA smooth_d".into(),
            "Keltner uses EMA(close) plus/minus multiplier times Wilder ATR; choppiness uses 100*log10(sum(TR, period)/(rolling_high-rolling_low))/log10(period), with period 1 or a flat range mapped to neutral 50".into(),
            "Aroon uses the current bar plus period prior bars and resolves equal extrema to the most recent occurrence".into(),
            "Supertrend uses hl2 plus/minus multiplier times Wilder ATR, carries final bands using the prior close, initializes the first ATR-ready bar bearish, and emits direction +1 bullish/-1 bearish".into(),
            "Parabolic SAR uses two-bar close direction initialization (ties bullish), the two-bar extreme as initial SAR/EP, strict reversal crossings, prior-two-bar clamps, and direction +1 bullish/-1 bearish".into(),
            "volume indicators support stock and ETF instruments; index, fund, and other instruments return unsupported_instrument without affecting price indicators".into(),
            "volume null is never coerced to zero: rolling indicators emit unavailable for affected complete windows and recover after a complete window; cumulative OBV and A/D restart from a documented seed at each contiguous volume segment".into(),
            "zero volume is a valid observation; relative volume is current volume divided by the SMA of the preceding period volumes (excluding the current bar), maps 0/0 to 0, and marks a positive current volume over a zero baseline unavailable instead of fabricating a finite ratio".into(),
            "OBV seeds each contiguous segment at 0, adds/subtracts current volume by close direction, and carries on unchanged closes; A/D seeds each segment with its first money-flow volume".into(),
            "MFI uses typical price times current volume over period directional observations, maps no negative flow to 100 and two zero flows to neutral 50; equal typical prices add neither flow".into(),
            "CMF and A/D use ((close-low)-(high-close))/(high-low), map a zero high-low range to 0, and CMF maps a zero rolling volume denominator to 0".into(),
            "volume availability is available for complete coverage, partial for mixed null coverage with calculable points, insufficient_history when no complete calculation window exists, volume_unavailable when every volume is null, and unsupported_instrument outside stock/ETF".into(),
            "VWAP uses cumulative HLC3 times caller-supplied bar volume from the request-series start; it is a bar-level approximation rather than execution-grade intrabar VWAP and does not implicitly reset on calendar sessions".into(),
            "user_date and signal_date anchors resolve to the first supplied bar on or after anchor_date; recent_high and recent_low anchors are causal trailing windows including the current bar and choose the most recent equal extreme, so appending future bars cannot change prior values".into(),
            "anchored VWAP and standard VWAP mark a point unavailable when its anchor range contains missing volume or has zero cumulative volume; no price is fabricated for a zero denominator".into(),
            "volume profile is a focused one-instrument snapshot with at most 200 buckets; each bar's full volume is assigned to its selected close or HLC3 bucket because intrabar price-volume distribution is unavailable".into(),
            format!("volume profile focused requests accept exactly one indicator and at most {MAX_VOLUME_PROFILE_OBSERVATIONS} observations so full-series response size is structurally bounded"),
            "volume profile chooses the higher-price bucket for equal POC volume and expands a contiguous value area from POC toward the larger adjacent bucket, choosing higher on a tie, until the requested volume target is met".into(),
        ],
    };
    checkpoint(control)?;
    Ok(TechnicalAnalysisResult {
        schema_version: TECHNICAL_ANALYSIS_RESULT_SCHEMA_VERSION.into(),
        indicator_engine_version: INDICATOR_ENGINE_VERSION.into(),
        response_mode: request.response_mode,
        adjustment_policy: request.adjustment_policy,
        calculations,
        diagnostics,
    })
}

pub mod primitives {
    use super::*;

    struct FenwickWindow {
        counts: Vec<i64>,
        sums: Vec<f64>,
    }

    impl FenwickWindow {
        fn new(size: usize) -> Self {
            Self {
                counts: vec![0; size + 1],
                sums: vec![0.0; size + 1],
            }
        }

        fn add(&mut self, index: usize, count: i64, sum: f64) {
            let mut position = index + 1;
            while position < self.counts.len() {
                self.counts[position] += count;
                self.sums[position] += sum;
                position += position & position.wrapping_neg();
            }
        }

        fn prefix(&self, end: usize) -> (i64, f64) {
            let mut count = 0_i64;
            let mut sum = 0.0;
            let mut position = end;
            while position > 0 {
                count += self.counts[position];
                sum += self.sums[position];
                position &= position - 1;
            }
            (count, sum)
        }
    }

    fn validate_values(values: &[f64]) -> Result<()> {
        ensure!(
            values.iter().all(|value| value.is_finite()),
            "rolling input values must be finite"
        );
        Ok(())
    }

    fn validate_period(period: usize) -> Result<()> {
        ensure!(period > 0, "rolling period must be positive");
        Ok(())
    }

    pub fn rolling_sum(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        validate_values(values)?;
        validate_period(period)?;
        let mut output = vec![None; values.len()];
        let mut sum = 0.0;
        for (index, value) in values.iter().enumerate() {
            sum += value;
            if index >= period {
                sum -= values[index - period];
            }
            if index + 1 >= period {
                output[index] = Some(sum);
            }
        }
        Ok(output)
    }

    pub fn rolling_mean(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        Ok(rolling_sum(values, period)?
            .into_iter()
            .map(|value| value.map(|value| value / period as f64))
            .collect())
    }

    fn rolling_extreme(values: &[f64], period: usize, minimum: bool) -> Result<Vec<Option<f64>>> {
        validate_values(values)?;
        validate_period(period)?;
        let mut output = vec![None; values.len()];
        let mut deque = VecDeque::<usize>::new();
        for index in 0..values.len() {
            while deque.front().is_some_and(|front| *front + period <= index) {
                deque.pop_front();
            }
            while deque.back().is_some_and(|back| {
                if minimum {
                    values[*back] >= values[index]
                } else {
                    values[*back] <= values[index]
                }
            }) {
                deque.pop_back();
            }
            deque.push_back(index);
            if index + 1 >= period {
                output[index] = deque.front().map(|position| values[*position]);
            }
        }
        Ok(output)
    }

    pub fn rolling_min(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        rolling_extreme(values, period, true)
    }

    pub fn rolling_max(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        rolling_extreme(values, period, false)
    }

    pub fn rolling_population_stddev(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        validate_values(values)?;
        validate_period(period)?;
        let mut output = vec![None; values.len()];
        if values.len() < period {
            return Ok(output);
        }
        if period == 1 {
            output.fill(Some(0.0));
            return Ok(output);
        }

        let mut mean = 0.0;
        let mut squared_deviation_sum = 0.0;
        for (index, value) in values[..period].iter().copied().enumerate() {
            let count = (index + 1) as f64;
            let delta = value - mean;
            mean += delta / count;
            squared_deviation_sum += delta * (value - mean);
        }
        output[period - 1] = Some((squared_deviation_sum / period as f64).max(0.0).sqrt());

        let count = period as f64;
        for index in period..values.len() {
            let removed = values[index - period];
            let mean_after_removal = mean + (mean - removed) / (count - 1.0);
            let squared_after_removal =
                squared_deviation_sum - (removed - mean) * (removed - mean_after_removal);
            let added = values[index];
            let delta = added - mean_after_removal;
            mean = mean_after_removal + delta / count;
            squared_deviation_sum = squared_after_removal + delta * (added - mean);
            output[index] = Some((squared_deviation_sum / count).max(0.0).sqrt());
        }
        Ok(output)
    }

    pub fn rolling_mean_absolute_deviation(
        values: &[f64],
        period: usize,
    ) -> Result<Vec<Option<f64>>> {
        validate_values(values)?;
        validate_period(period)?;
        let mut output = vec![None; values.len()];
        if values.len() < period {
            return Ok(output);
        }

        let mut coordinates = values.to_vec();
        coordinates.sort_by(f64::total_cmp);
        coordinates.dedup_by(|left, right| left.total_cmp(right).is_eq());
        let coordinate = |value: f64| {
            coordinates
                .binary_search_by(|candidate| candidate.total_cmp(&value))
                .expect("every rolling value is present in the coordinate index")
        };
        let mut window = FenwickWindow::new(coordinates.len());
        let mut running_sum = 0.0;
        for value in values[..period].iter().copied() {
            window.add(coordinate(value), 1, value);
            running_sum += value;
        }

        for index in period - 1..values.len() {
            if index >= period {
                let removed = values[index - period];
                let added = values[index];
                window.add(coordinate(removed), -1, -removed);
                window.add(coordinate(added), 1, added);
                running_sum += added - removed;
            }
            let mean = running_sum / period as f64;
            let partition = coordinates.partition_point(|value| *value <= mean);
            let (lower_count, lower_sum) = window.prefix(partition);
            let upper_count = period as i64 - lower_count;
            let upper_sum = running_sum - lower_sum;
            let absolute_sum =
                mean * lower_count as f64 - lower_sum + upper_sum - mean * upper_count as f64;
            output[index] = Some((absolute_sum / period as f64).max(0.0));
        }
        Ok(output)
    }

    pub fn ema(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        validate_values(values)?;
        validate_period(period)?;
        let mut output = vec![None; values.len()];
        if values.len() < period {
            return Ok(output);
        }
        let seed = values[..period].iter().sum::<f64>() / period as f64;
        output[period - 1] = Some(seed);
        let alpha = 2.0 / (period as f64 + 1.0);
        let mut previous = seed;
        for index in period..values.len() {
            previous = alpha * values[index] + (1.0 - alpha) * previous;
            output[index] = Some(previous);
        }
        Ok(output)
    }

    pub fn wilder_smoothing(values: &[f64], period: usize) -> Result<Vec<Option<f64>>> {
        validate_values(values)?;
        validate_period(period)?;
        let mut output = vec![None; values.len()];
        if values.len() < period {
            return Ok(output);
        }
        let seed = values[..period].iter().sum::<f64>() / period as f64;
        output[period - 1] = Some(seed);
        let mut previous = seed;
        for index in period..values.len() {
            previous = (previous * (period - 1) as f64 + values[index]) / period as f64;
            output[index] = Some(previous);
        }
        Ok(output)
    }

    pub fn true_range(high: &[f64], low: &[f64], close: &[f64]) -> Result<Vec<f64>> {
        ensure!(
            high.len() == low.len() && low.len() == close.len(),
            "true range OHLC lengths must match"
        );
        validate_values(high)?;
        validate_values(low)?;
        validate_values(close)?;
        ensure!(
            high.iter().zip(low).all(|(high, low)| high >= low),
            "true range high must be greater than or equal to low"
        );
        Ok((0..high.len())
            .map(|index| {
                if index == 0 {
                    high[index] - low[index]
                } else {
                    (high[index] - low[index])
                        .max((high[index] - close[index - 1]).abs())
                        .max((low[index] - close[index - 1]).abs())
                }
            })
            .collect())
    }

    pub fn typical_price(high: &[f64], low: &[f64], close: &[f64]) -> Result<Vec<f64>> {
        ensure!(
            high.len() == low.len() && low.len() == close.len(),
            "typical price OHLC lengths must match"
        );
        validate_values(high)?;
        validate_values(low)?;
        validate_values(close)?;
        ensure!(
            high.iter().zip(low).all(|(high, low)| high >= low),
            "typical price high must be greater than or equal to low"
        );
        Ok(high
            .iter()
            .zip(low)
            .zip(close)
            .map(|((high, low), close)| low + (high - low) / 3.0 + (close - low) / 3.0)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use approx::assert_abs_diff_eq;
    use serde_json::json;

    use super::primitives::*;
    use super::*;

    fn bars() -> Vec<OhlcvBar> {
        [
            ("2024-01-02", 10.0, 11.0, 9.0, 10.5, Some(100.0)),
            ("2024-01-03", 10.5, 12.0, 10.0, 11.5, Some(120.0)),
            ("2024-01-04", 11.5, 13.0, 11.0, 12.0, None),
            ("2024-01-05", 12.0, 12.5, 10.5, 11.0, Some(90.0)),
        ]
        .into_iter()
        .map(|(date, open, high, low, close, volume)| OhlcvBar {
            date: date.into(),
            open,
            high,
            low,
            close,
            volume,
        })
        .collect()
    }

    fn instrument(key: &str) -> InstrumentSeries {
        InstrumentSeries {
            key: key.into(),
            symbol: key.to_uppercase(),
            market: "KR".into(),
            currency: "KRW".into(),
            instrument_type: InstrumentType::Stock,
            bars: bars(),
        }
    }

    fn definition(id: &str, kind: IndicatorKind, target: &str) -> IndicatorDefinition {
        IndicatorDefinition {
            id: id.into(),
            kind,
            parameters: BTreeMap::new(),
            instrument_keys: Some(vec![target.into()]),
        }
    }

    fn request(mode: ResponseMode) -> TechnicalAnalysisRequest {
        TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: mode,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            instruments: vec![instrument("z"), instrument("a")],
            indicators: vec![
                definition("z_ema", IndicatorKind::Ema, "z"),
                IndicatorDefinition {
                    parameters: BTreeMap::from([("period".into(), json!(3))]),
                    ..definition("a_sma", IndicatorKind::Sma, "a")
                },
            ],
        }
    }

    fn instrument_from_closes(key: &str, closes: &[f64]) -> InstrumentSeries {
        InstrumentSeries {
            key: key.into(),
            symbol: key.to_uppercase(),
            market: "TEST".into(),
            currency: "USD".into(),
            instrument_type: InstrumentType::Stock,
            bars: closes
                .iter()
                .enumerate()
                .map(|(index, close)| OhlcvBar {
                    date: crate::date::add_days("2024-01-01", index as i64).unwrap(),
                    open: *close,
                    high: close + 1.0,
                    low: (close - 1.0).max(0.1),
                    close: *close,
                    volume: Some(100.0 + index as f64),
                })
                .collect(),
        }
    }

    fn instrument_from_ohlc(key: &str, bars: &[(f64, f64, f64, f64)]) -> InstrumentSeries {
        InstrumentSeries {
            key: key.into(),
            symbol: key.to_uppercase(),
            market: "TEST".into(),
            currency: "USD".into(),
            instrument_type: InstrumentType::Stock,
            bars: bars
                .iter()
                .enumerate()
                .map(|(index, (open, high, low, close))| OhlcvBar {
                    date: crate::date::add_days("2024-01-01", index as i64).unwrap(),
                    open: *open,
                    high: *high,
                    low: *low,
                    close: *close,
                    volume: None,
                })
                .collect(),
        }
    }

    fn with_volumes(mut instrument: InstrumentSeries, volumes: &[Option<f64>]) -> InstrumentSeries {
        assert_eq!(instrument.bars.len(), volumes.len());
        for (bar, volume) in instrument.bars.iter_mut().zip(volumes) {
            bar.volume = *volume;
        }
        instrument
    }

    fn with_parameters(
        mut definition: IndicatorDefinition,
        parameters: impl IntoIterator<Item = (&'static str, Value)>,
    ) -> IndicatorDefinition {
        definition.parameters = parameters
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect();
        definition
    }

    fn calculate(
        instruments: Vec<InstrumentSeries>,
        definition: IndicatorDefinition,
        mode: ResponseMode,
    ) -> IndicatorCalculation {
        let result = analyze(
            &TechnicalAnalysisRequest {
                schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
                response_mode: mode,
                adjustment_policy: AdjustmentPolicy::Adjusted,
                instruments,
                indicators: vec![definition],
            },
            None,
        )
        .unwrap();
        assert_eq!(result.calculations.len(), 1);
        result.calculations.into_iter().next().unwrap()
    }

    fn point_value(point: &IndicatorPoint, name: &str) -> f64 {
        point.values[name].expect("golden point value")
    }

    fn calculate_full_with_latest_parity(
        instruments: Vec<InstrumentSeries>,
        definition: IndicatorDefinition,
    ) -> IndicatorCalculation {
        let full = calculate(
            instruments.clone(),
            definition.clone(),
            ResponseMode::FullSeries,
        );
        let expected_latest = full
            .points
            .as_ref()
            .and_then(|points| points.last())
            .cloned()
            .expect("test instruments always contain at least one bar");
        let latest = calculate(instruments, definition, ResponseMode::LatestSummary);
        assert!(latest.points.is_none());
        assert_eq!(latest.latest.as_ref(), Some(&expected_latest));
        assert_eq!(latest.availability, full.availability);
        assert_eq!(latest.warmup, full.warmup);
        full
    }

    #[test]
    fn catalog_has_all_31_stable_indicator_kinds() {
        assert_eq!(INDICATOR_ENGINE_VERSION, "technical-indicators/1.5.0");
        let catalog = indicator_catalog();
        assert_eq!(catalog.len(), 31);
        assert_eq!(catalog[0].kind, IndicatorKind::Sma);
        assert_eq!(catalog[30].kind, IndicatorKind::VolumeProfile);
        assert!(catalog.iter().all(|entry| !entry.output_fields.is_empty()));
        assert_eq!(
            catalog_entry(IndicatorKind::BollingerBands).parameters["period"].default,
            Some(json!(20))
        );
    }

    #[test]
    fn full_series_is_sorted_and_explicitly_models_warmup_null_and_available() {
        let result = analyze(&request(ResponseMode::FullSeries), None).unwrap();
        assert_eq!(
            result.schema_version,
            TECHNICAL_ANALYSIS_RESULT_SCHEMA_VERSION
        );
        assert_eq!(result.indicator_engine_version, INDICATOR_ENGINE_VERSION);
        assert_eq!(result.calculations.len(), 2);
        assert_eq!(result.calculations[0].instrument_key, "a");
        assert_eq!(result.calculations[0].indicator_id, "a_sma");
        assert_eq!(result.calculations[1].instrument_key, "z");
        assert_eq!(result.calculations[1].indicator_id, "z_ema");
        assert_eq!(result.diagnostics.policies.standard_deviation, "population");
        assert_eq!(result.diagnostics.policies.ema_seed, "first_period_sma");
        assert_eq!(
            result.diagnostics.policies.volume_missing,
            "preserve_json_null_and_mark_affected_points_unavailable"
        );
        assert_eq!(
            result.diagnostics.policies.volume_input_unit,
            "caller_supplied_non_negative_provider_units"
        );
        assert_eq!(
            result.diagnostics.policies.volume_adjustment,
            "no_worker_adjustment_caller_responsible_for_provider_corporate_action_semantics"
        );
        assert_eq!(
            result.diagnostics.policies.volume_currency_conversion,
            "none"
        );

        let calculation = &result.calculations[0];
        assert_eq!(calculation.parameters["period"], 3);
        assert_eq!(
            calculation.availability.status,
            AvailabilityStatus::Available
        );
        assert_eq!(calculation.warmup.required_observations, 3);
        assert_eq!(calculation.warmup.state, WarmupState::Ready);
        assert_eq!(
            calculation.warmup.first_available_date.as_deref(),
            Some("2024-01-04")
        );
        let points = calculation.points.as_ref().unwrap();
        assert_eq!(
            points.iter().map(|point| point.state).collect::<Vec<_>>(),
            vec![
                PointState::Warmup,
                PointState::Warmup,
                PointState::Available,
                PointState::Available,
            ]
        );
        assert!(
            points[..2]
                .iter()
                .all(|point| point.values["value"].is_none())
        );
        assert_abs_diff_eq!(
            points[2].values["value"].unwrap(),
            34.0 / 3.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(points[3].values["value"].unwrap(), 11.5, epsilon = 1e-12);
        assert!(calculation.latest.is_none());
    }

    #[test]
    fn latest_summary_omits_full_points_and_preserves_latest_state() {
        let full = analyze(&request(ResponseMode::FullSeries), None).unwrap();
        let result = analyze(&request(ResponseMode::LatestSummary), None).unwrap();
        assert!(result.calculations.iter().all(|item| item.points.is_none()));
        assert_eq!(
            result.calculations[0].latest.as_ref().unwrap().date,
            "2024-01-05"
        );
        let serialized = serde_json::to_value(result).unwrap();
        assert!(serialized["calculations"][0].get("points").is_none());
        assert!(serialized["calculations"][0].get("latest").is_some());
        for (full, latest) in full.calculations.iter().zip(
            analyze(&request(ResponseMode::LatestSummary), None)
                .unwrap()
                .calculations,
        ) {
            assert_eq!(latest.latest.as_ref(), full.points.as_ref().unwrap().last());
        }
    }

    #[test]
    fn strict_series_validation_rejects_bad_dates_order_ohlc_volume_and_non_finite_values() {
        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[0].bars[1].date = "2024-02-30".into();
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("invalid bar date")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[0].bars[1].date = invalid.instruments[0].bars[0].date.clone();
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("strictly date-ascending")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[0].bars[0].high = 9.5;
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("range is inconsistent")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[0].bars[0].volume = Some(-1.0);
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("non-negative")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[0].bars[0].close = f64::INFINITY;
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("finite and positive")
        );
    }

    #[test]
    fn strict_request_validation_rejects_wrong_shape_duplicates_and_unknown_targets() {
        let mut invalid = request(ResponseMode::FullSeries);
        invalid.schema_version = "technical-analysis-request/v0".into();
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("unsupported")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[1].key = "z".into();
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("keys must be unique")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.instruments[0].bars.clear();
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("bars must contain")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.indicators[1].id = "z_ema".into();
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("ids must be unique")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.indicators[0].instrument_keys = Some(vec!["missing".into()]);
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("unknown target")
        );

        let source = serde_json::to_value(request(ResponseMode::FullSeries)).unwrap();
        let mut object = source.as_object().unwrap().clone();
        object.insert("unexpected".into(), json!(true));
        assert!(serde_json::from_value::<TechnicalAnalysisRequest>(Value::Object(object)).is_err());
    }

    #[test]
    fn indicator_parameter_catalog_applies_defaults_and_rejects_invalid_combinations() {
        let mut invalid = request(ResponseMode::FullSeries);
        invalid.indicators[0]
            .parameters
            .insert("unknown".into(), json!(1));
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("unsupported parameter")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.indicators[0] = IndicatorDefinition {
            parameters: BTreeMap::from([
                ("fast_period".into(), json!(30)),
                ("slow_period".into(), json!(20)),
            ]),
            ..definition("macd", IndicatorKind::Macd, "z")
        };
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("fast_period < slow_period")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.indicators[0] =
            definition("relative", IndicatorKind::BenchmarkRelativeStrength, "z");
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("requires parameter benchmark_key")
        );

        let mut invalid = request(ResponseMode::FullSeries);
        invalid.indicators[0] = IndicatorDefinition {
            parameters: BTreeMap::from([("anchor".into(), json!("user_date"))]),
            ..definition("vwap", IndicatorKind::VwapAnchoredVwap, "z")
        };
        assert!(
            analyze(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("requires anchor_date")
        );

        let mut invalid_signal = request(ResponseMode::FullSeries);
        invalid_signal.indicators[0] = IndicatorDefinition {
            parameters: BTreeMap::from([("anchor".into(), json!("signal_date"))]),
            ..definition("vwap", IndicatorKind::VwapAnchoredVwap, "z")
        };
        assert!(
            analyze(&invalid_signal, None)
                .unwrap_err()
                .to_string()
                .contains("requires anchor_date")
        );

        let mut valid = request(ResponseMode::FullSeries);
        valid.indicators[0] = IndicatorDefinition {
            parameters: BTreeMap::from([
                ("anchor".into(), json!("user_date")),
                ("anchor_date".into(), json!("2024-01-03")),
            ]),
            ..definition("vwap", IndicatorKind::VwapAnchoredVwap, "z")
        };
        assert!(analyze(&valid, None).is_ok());
        valid.indicators[0]
            .parameters
            .insert("anchor".into(), json!("signal_date"));
        assert!(analyze(&valid, None).is_ok());
    }

    #[test]
    fn sma_ema_bollinger_and_moving_average_distance_match_golden_values() {
        let asset = instrument_from_closes("asset", &[1.0, 2.0, 3.0, 4.0, 5.0]);
        let sma = calculate(
            vec![asset.clone()],
            with_parameters(
                definition("sma", IndicatorKind::Sma, "asset"),
                [("period", json!(3))],
            ),
            ResponseMode::FullSeries,
        );
        let sma_points = sma.points.unwrap();
        assert_eq!(sma_points[0].state, PointState::Warmup);
        assert_eq!(sma_points[1].state, PointState::Warmup);
        assert_abs_diff_eq!(point_value(&sma_points[2], "value"), 2.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&sma_points[4], "value"), 4.0, epsilon = 1e-12);

        let ema = calculate(
            vec![asset.clone()],
            with_parameters(
                definition("ema", IndicatorKind::Ema, "asset"),
                [("period", json!(3))],
            ),
            ResponseMode::FullSeries,
        );
        let ema_points = ema.points.unwrap();
        assert_abs_diff_eq!(point_value(&ema_points[2], "value"), 2.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&ema_points[3], "value"), 3.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&ema_points[4], "value"), 4.0, epsilon = 1e-12);

        let bollinger = calculate(
            vec![asset.clone()],
            with_parameters(
                definition("bands", IndicatorKind::BollingerBands, "asset"),
                [("period", json!(3)), ("stddev_multiplier", json!(2.0))],
            ),
            ResponseMode::FullSeries,
        );
        let band = &bollinger.points.unwrap()[2];
        let deviation = (2.0_f64 / 3.0).sqrt();
        assert_abs_diff_eq!(point_value(band, "middle"), 2.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(band, "upper"),
            2.0 + 2.0 * deviation,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            point_value(band, "lower"),
            2.0 - 2.0 * deviation,
            epsilon = 1e-12
        );

        let distance = calculate(
            vec![asset],
            with_parameters(
                definition("distance", IndicatorKind::MovingAverageDistance, "asset"),
                [("period", json!(3)), ("average_type", json!("sma"))],
            ),
            ResponseMode::FullSeries,
        );
        let distance_points = distance.points.unwrap();
        assert_abs_diff_eq!(
            point_value(&distance_points[2], "moving_average"),
            2.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            point_value(&distance_points[2], "distance_percent"),
            50.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            point_value(&distance_points[4], "distance_percent"),
            25.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn selected_price_source_is_used_without_browser_side_recalculation() {
        let mut asset = instrument_from_closes("asset", &[2.0, 4.0, 6.0]);
        for bar in &mut asset.bars {
            bar.open = bar.close + 0.5;
            bar.high = bar.close + 1.0;
        }
        let calculation = calculate(
            vec![asset],
            with_parameters(
                definition("open-sma", IndicatorKind::Sma, "asset"),
                [("period", json!(2)), ("source", json!("open"))],
            ),
            ResponseMode::FullSeries,
        );
        let points = calculation.points.unwrap();
        assert_abs_diff_eq!(point_value(&points[1], "value"), 3.5, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[2], "value"), 5.5, epsilon = 1e-12);
    }

    #[test]
    fn rsi_uses_wilder_close_deltas_and_declared_zero_loss_edges() {
        let rsi = |id: &str, closes: &[f64]| {
            calculate(
                vec![instrument_from_closes("asset", closes)],
                with_parameters(
                    definition(id, IndicatorKind::Rsi, "asset"),
                    [("period", json!(3))],
                ),
                ResponseMode::FullSeries,
            )
        };
        let rising = rsi("rising", &[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(rising.warmup.required_observations, 4);
        assert_eq!(
            rising.warmup.first_available_date.as_deref(),
            Some("2024-01-04")
        );
        assert_abs_diff_eq!(
            point_value(&rising.points.unwrap()[3], "value"),
            100.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            point_value(
                &rsi("flat", &[5.0, 5.0, 5.0, 5.0]).points.unwrap()[3],
                "value"
            ),
            50.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            point_value(
                &rsi("falling", &[4.0, 3.0, 2.0, 1.0]).points.unwrap()[3],
                "value"
            ),
            0.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn macd_signal_is_sma_seeded_over_the_first_valid_macd_values() {
        let calculation = calculate(
            vec![instrument_from_closes(
                "asset",
                &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
            )],
            with_parameters(
                definition("macd", IndicatorKind::Macd, "asset"),
                [
                    ("fast_period", json!(2)),
                    ("slow_period", json!(3)),
                    ("signal_period", json!(2)),
                ],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(calculation.warmup.required_observations, 4);
        assert_eq!(
            calculation.warmup.first_available_date.as_deref(),
            Some("2024-01-04")
        );
        let points = calculation.points.unwrap();
        assert!(
            points[..3]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        for point in &points[3..] {
            assert_abs_diff_eq!(point_value(point, "macd"), 0.5, epsilon = 1e-12);
            assert_abs_diff_eq!(point_value(point, "signal"), 0.5, epsilon = 1e-12);
            assert_abs_diff_eq!(point_value(point, "histogram"), 0.0, epsilon = 1e-12);
        }
    }

    #[test]
    fn atr_and_donchian_include_the_current_bar_and_match_gap_goldens() {
        let asset = InstrumentSeries {
            key: "asset".into(),
            symbol: "ASSET".into(),
            market: "TEST".into(),
            currency: "USD".into(),
            instrument_type: InstrumentType::Stock,
            bars: vec![
                OhlcvBar {
                    date: "2024-01-01".into(),
                    open: 9.0,
                    high: 10.0,
                    low: 8.0,
                    close: 9.0,
                    volume: None,
                },
                OhlcvBar {
                    date: "2024-01-02".into(),
                    open: 10.0,
                    high: 12.0,
                    low: 9.0,
                    close: 10.0,
                    volume: None,
                },
                OhlcvBar {
                    date: "2024-01-03".into(),
                    open: 8.0,
                    high: 11.0,
                    low: 7.0,
                    close: 8.0,
                    volume: None,
                },
            ],
        };
        let atr = calculate(
            vec![asset.clone()],
            with_parameters(
                definition("atr", IndicatorKind::Atr, "asset"),
                [("period", json!(2))],
            ),
            ResponseMode::FullSeries,
        );
        let atr_points = atr.points.unwrap();
        assert_abs_diff_eq!(point_value(&atr_points[1], "atr"), 2.5, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&atr_points[2], "atr"), 3.25, epsilon = 1e-12);

        let donchian = calculate(
            vec![asset],
            with_parameters(
                definition("donchian", IndicatorKind::DonchianChannel, "asset"),
                [("period", json!(2))],
            ),
            ResponseMode::FullSeries,
        );
        let points = donchian.points.unwrap();
        assert_abs_diff_eq!(point_value(&points[1], "upper"), 12.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "lower"), 8.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "middle"), 10.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[2], "upper"), 12.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[2], "lower"), 7.0, epsilon = 1e-12);
    }

    #[test]
    fn benchmark_relative_strength_inner_joins_dates_and_normalizes_the_first_ratio() {
        let asset = instrument_from_closes("asset", &[10.0, 12.0, 15.0]);
        let mut benchmark = instrument_from_closes("benchmark", &[20.0, 25.0]);
        benchmark.bars[1].date = "2024-01-03".into();
        let relative = calculate(
            vec![benchmark.clone(), asset.clone()],
            with_parameters(
                definition(
                    "relative",
                    IndicatorKind::BenchmarkRelativeStrength,
                    "asset",
                ),
                [("benchmark_key", json!("benchmark"))],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(relative.availability.status, AvailabilityStatus::Partial);
        assert_eq!(
            relative.availability.reason,
            "partial_benchmark_date_coverage"
        );
        assert_eq!(relative.warmup.observed_observations, 2);
        assert_eq!(
            relative.warmup.first_available_date.as_deref(),
            Some("2024-01-01")
        );
        let points = relative.points.unwrap();
        assert_abs_diff_eq!(
            point_value(&points[0], "relative_strength"),
            100.0,
            epsilon = 1e-12
        );
        assert_eq!(points[1].state, PointState::Unavailable);
        assert!(points[1].values["relative_strength"].is_none());
        assert_abs_diff_eq!(
            point_value(&points[2], "relative_strength"),
            120.0,
            epsilon = 1e-12
        );

        let self_relative = calculate(
            vec![benchmark.clone()],
            with_parameters(
                definition(
                    "self-relative",
                    IndicatorKind::BenchmarkRelativeStrength,
                    "benchmark",
                ),
                [("benchmark_key", json!("benchmark"))],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(
            self_relative.availability.status,
            AvailabilityStatus::Available
        );
        assert_eq!(self_relative.availability.reason, "calculated");
        assert!(
            self_relative
                .points
                .unwrap()
                .iter()
                .all(|point| { (point_value(point, "relative_strength") - 100.0).abs() < 1e-12 })
        );

        let no_common = calculate(
            vec![
                benchmark,
                InstrumentSeries {
                    key: "disconnected".into(),
                    symbol: "DISCONNECTED".into(),
                    market: "US".into(),
                    currency: "USD".into(),
                    instrument_type: InstrumentType::Stock,
                    bars: vec![
                        OhlcvBar {
                            date: "2024-02-01".into(),
                            open: 10.0,
                            high: 10.0,
                            low: 10.0,
                            close: 10.0,
                            volume: Some(1.0),
                        },
                        OhlcvBar {
                            date: "2024-02-02".into(),
                            open: 11.0,
                            high: 11.0,
                            low: 11.0,
                            close: 11.0,
                            volume: Some(1.0),
                        },
                    ],
                },
            ],
            with_parameters(
                definition(
                    "disconnected-relative",
                    IndicatorKind::BenchmarkRelativeStrength,
                    "disconnected",
                ),
                [("benchmark_key", json!("benchmark"))],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(
            no_common.availability.status,
            AvailabilityStatus::InsufficientHistory
        );
        assert_eq!(
            no_common.availability.reason,
            "no_common_benchmark_observation"
        );
        assert_eq!(no_common.warmup.observed_observations, 0);
        assert!(
            no_common
                .points
                .unwrap()
                .iter()
                .all(|point| point.state == PointState::Unavailable)
        );
    }

    #[test]
    fn high_low_position_uses_current_bar_and_returns_fifty_for_a_flat_range() {
        let position = calculate(
            vec![instrument_from_closes("asset", &[10.0, 11.0, 12.0])],
            with_parameters(
                definition(
                    "position",
                    IndicatorKind::FiftyTwoWeekHighLowPosition,
                    "asset",
                ),
                [("period", json!(3))],
            ),
            ResponseMode::FullSeries,
        );
        let point = &position.points.unwrap()[2];
        assert_abs_diff_eq!(point_value(point, "rolling_high"), 13.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(point, "rolling_low"), 9.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(point, "position_percent"),
            75.0,
            epsilon = 1e-12
        );

        let mut flat = instrument_from_closes("flat", &[10.0, 10.0, 10.0]);
        for bar in &mut flat.bars {
            bar.open = 10.0;
            bar.high = 10.0;
            bar.low = 10.0;
            bar.close = 10.0;
        }
        let flat_position = calculate(
            vec![flat],
            with_parameters(
                definition(
                    "flat-position",
                    IndicatorKind::FiftyTwoWeekHighLowPosition,
                    "flat",
                ),
                [("period", json!(3))],
            ),
            ResponseMode::FullSeries,
        );
        assert_abs_diff_eq!(
            point_value(&flat_position.points.unwrap()[2], "position_percent"),
            50.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn adx_dmi_uses_wilder_delta_windows_and_zero_range_is_neutral() {
        let trending = instrument_from_ohlc(
            "asset",
            &[
                (9.0, 10.0, 8.0, 9.0),
                (10.0, 11.0, 9.0, 10.0),
                (11.0, 12.0, 10.0, 11.0),
                (12.0, 13.0, 11.0, 12.0),
            ],
        );
        let definition = with_parameters(
            definition("adx", IndicatorKind::AdxDmi, "asset"),
            [("period", json!(2))],
        );
        let calculation = calculate_full_with_latest_parity(vec![trending], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 4);
        let points = calculation.points.unwrap();
        assert!(
            points[..3]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[3], "adx"), 100.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[3], "plus_di"), 50.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[3], "minus_di"), 0.0, epsilon = 1e-12);

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 4]);
        let flat = calculate_full_with_latest_parity(vec![flat], definition);
        let point = &flat.points.unwrap()[3];
        for field in ["adx", "plus_di", "minus_di"] {
            assert_abs_diff_eq!(point_value(point, field), 0.0, epsilon = 1e-12);
        }
    }

    #[test]
    fn stochastic_smooths_raw_k_and_flat_range_is_fifty() {
        let oscillating = instrument_from_ohlc(
            "asset",
            &[
                (6.0, 11.0, 1.0, 6.0),
                (6.0, 11.0, 1.0, 11.0),
                (6.0, 11.0, 1.0, 1.0),
            ],
        );
        let definition = with_parameters(
            definition("stochastic", IndicatorKind::StochasticOscillator, "asset"),
            [
                ("lookback_period", json!(2)),
                ("smooth_k", json!(1)),
                ("smooth_d", json!(2)),
            ],
        );
        let calculation = calculate_full_with_latest_parity(vec![oscillating], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert!(
            points[..2]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[2], "percent_k"), 0.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[2], "percent_d"), 50.0, epsilon = 1e-12);

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 3]);
        let flat = calculate_full_with_latest_parity(vec![flat], definition);
        let point = &flat.points.unwrap()[2];
        assert_abs_diff_eq!(point_value(point, "percent_k"), 50.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(point, "percent_d"), 50.0, epsilon = 1e-12);
    }

    #[test]
    fn roc_is_percent_change_from_the_exact_period_prior_source() {
        let definition = with_parameters(
            definition("roc", IndicatorKind::Roc, "asset"),
            [("period", json!(2))],
        );
        let calculation = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[100.0, 110.0, 121.0])],
            definition.clone(),
        );
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert!(
            points[..2]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[2], "value"), 21.0, epsilon = 1e-12);

        let flat = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[100.0, 100.0, 100.0])],
            definition,
        );
        assert_abs_diff_eq!(point_value(&flat.points.unwrap()[2], "value"), 0.0);
    }

    #[test]
    fn keltner_uses_close_ema_and_wilder_atr() {
        let definition = with_parameters(
            definition("keltner", IndicatorKind::KeltnerChannel, "asset"),
            [
                ("ema_period", json!(2)),
                ("atr_period", json!(2)),
                ("multiplier", json!(1.0)),
            ],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[(10.0, 11.0, 9.0, 10.0), (12.0, 13.0, 11.0, 12.0)],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 2);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_abs_diff_eq!(point_value(&points[1], "middle"), 11.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "upper"), 13.5, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "lower"), 8.5, epsilon = 1e-12);

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 2]);
        let flat = calculate_full_with_latest_parity(vec![flat], definition);
        let point = &flat.points.unwrap()[1];
        for field in ["upper", "middle", "lower"] {
            assert_abs_diff_eq!(point_value(point, field), 10.0, epsilon = 1e-12);
        }
    }

    #[test]
    fn supertrend_carries_final_bands_and_starts_bearish() {
        let definition = with_parameters(
            definition("supertrend", IndicatorKind::Supertrend, "asset"),
            [("atr_period", json!(2)), ("multiplier", json!(1.0))],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[
                (10.0, 11.0, 9.0, 10.0),
                (12.0, 13.0, 11.0, 12.0),
                (15.0, 16.0, 14.0, 15.5),
            ],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 2);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_abs_diff_eq!(point_value(&points[1], "supertrend"), 14.5, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "direction"), -1.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(&points[2], "supertrend"),
            11.75,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(point_value(&points[2], "direction"), 1.0, epsilon = 1e-12);

        let tie = instrument_from_ohlc(
            "asset",
            &[
                (10.0, 11.0, 9.0, 10.0),
                (12.0, 13.0, 11.0, 12.0),
                (14.5, 16.0, 14.0, 14.5),
            ],
        );
        let tie = calculate_full_with_latest_parity(vec![tie], definition);
        assert_abs_diff_eq!(
            point_value(&tie.points.unwrap()[2], "direction"),
            -1.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn historical_volatility_annualizes_population_return_deviation() {
        let simple_definition = with_parameters(
            definition("volatility", IndicatorKind::HistoricalVolatility, "asset"),
            [
                ("period", json!(2)),
                ("annualization", json!(1)),
                ("return_type", json!("simple")),
            ],
        );
        let calculation = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[100.0, 110.0, 110.0])],
            simple_definition.clone(),
        );
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert!(
            points[..2]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[2], "value"), 5.0, epsilon = 1e-12);

        let flat = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[100.0, 100.0, 100.0])],
            simple_definition,
        );
        assert_abs_diff_eq!(
            point_value(&flat.points.unwrap()[2], "value"),
            0.0,
            epsilon = 1e-12
        );

        let log_definition = with_parameters(
            definition(
                "log-volatility",
                IndicatorKind::HistoricalVolatility,
                "asset",
            ),
            [
                ("period", json!(2)),
                ("annualization", json!(1)),
                ("return_type", json!("log")),
            ],
        );
        let log = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[100.0, 110.0, 110.0])],
            log_definition,
        );
        assert_abs_diff_eq!(
            point_value(&log.points.unwrap()[2], "value"),
            50.0 * 1.1_f64.ln(),
            epsilon = 1e-12
        );
    }

    #[test]
    fn normalized_atr_is_a_close_percent_and_zero_range_is_zero() {
        let definition = with_parameters(
            definition("natr", IndicatorKind::NormalizedAtr, "asset"),
            [("period", json!(2))],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[(10.0, 11.0, 9.0, 10.0), (12.0, 13.0, 11.0, 12.0)],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 2);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_abs_diff_eq!(
            point_value(&points[1], "value"),
            100.0 * 2.5 / 12.0,
            epsilon = 1e-12
        );

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 2]);
        let flat = calculate_full_with_latest_parity(vec![flat], definition);
        assert_abs_diff_eq!(
            point_value(&flat.points.unwrap()[1], "value"),
            0.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn bollinger_width_is_percent_and_percent_b_is_a_unit_ratio() {
        let definition = with_parameters(
            definition(
                "band-metrics",
                IndicatorKind::BollingerBandWidthPercentB,
                "asset",
            ),
            [("period", json!(2)), ("stddev_multiplier", json!(2.0))],
        );
        let calculation = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[10.0, 12.0])],
            definition.clone(),
        );
        assert_eq!(calculation.warmup.required_observations, 2);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        let point = &points[1];
        assert_abs_diff_eq!(point_value(point, "middle"), 11.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(point, "upper"), 13.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(point, "lower"), 9.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(point, "bandwidth"),
            400.0 / 11.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(point_value(point, "percent_b"), 0.75, epsilon = 1e-12);

        let flat = calculate_full_with_latest_parity(
            vec![instrument_from_closes("asset", &[10.0, 10.0])],
            definition,
        );
        let point = &flat.points.unwrap()[1];
        assert_abs_diff_eq!(point_value(point, "bandwidth"), 0.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(point, "percent_b"), 0.5, epsilon = 1e-12);
    }

    #[test]
    fn aroon_includes_current_bar_and_resolves_ties_to_the_most_recent() {
        let definition = with_parameters(
            definition("aroon", IndicatorKind::Aroon, "asset"),
            [("period", json!(2))],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[
                (9.0, 10.0, 8.0, 9.0),
                (11.0, 12.0, 9.0, 11.0),
                (10.0, 11.0, 7.0, 10.0),
            ],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert!(
            points[..2]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[2], "aroon_up"), 50.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(&points[2], "aroon_down"),
            100.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            point_value(&points[2], "oscillator"),
            -50.0,
            epsilon = 1e-12
        );

        let tie = instrument_from_ohlc(
            "asset",
            &[
                (10.0, 12.0, 8.0, 10.0),
                (10.0, 12.0, 9.0, 10.0),
                (10.0, 11.0, 10.0, 10.0),
            ],
        );
        let tie = calculate_full_with_latest_parity(vec![tie], definition);
        assert_abs_diff_eq!(
            point_value(&tie.points.unwrap()[2], "aroon_up"),
            50.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn cci_uses_typical_price_mean_deviation_and_flat_is_zero() {
        let definition = with_parameters(
            definition("cci", IndicatorKind::Cci, "asset"),
            [("period", json!(3)), ("constant", json!(0.015))],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[
                (10.0, 10.0, 10.0, 10.0),
                (11.0, 11.0, 11.0, 11.0),
                (13.0, 13.0, 13.0, 13.0),
            ],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert!(
            points[..2]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[2], "value"), 100.0, epsilon = 1e-10);

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 3]);
        let flat = calculate_full_with_latest_parity(vec![flat], definition);
        assert_abs_diff_eq!(
            point_value(&flat.points.unwrap()[2], "value"),
            0.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn williams_r_uses_current_range_and_flat_is_midpoint() {
        let definition = with_parameters(
            definition("williams", IndicatorKind::WilliamsR, "asset"),
            [("period", json!(3))],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[
                (9.0, 10.0, 8.0, 9.0),
                (11.0, 12.0, 9.0, 11.0),
                (10.0, 11.0, 7.0, 10.75),
            ],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert!(
            points[..2]
                .iter()
                .all(|point| point.state == PointState::Warmup)
        );
        assert_abs_diff_eq!(point_value(&points[2], "value"), -25.0, epsilon = 1e-12);

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 3]);
        let flat = calculate_full_with_latest_parity(vec![flat], definition);
        assert_abs_diff_eq!(
            point_value(&flat.points.unwrap()[2], "value"),
            -50.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn parabolic_sar_uses_two_bar_initialization_clamps_and_strict_reversal() {
        let definition = with_parameters(
            definition("sar", IndicatorKind::ParabolicSar, "asset"),
            [("step", json!(0.02)), ("max_step", json!(0.2))],
        );
        let asset = instrument_from_ohlc(
            "asset",
            &[
                (9.0, 10.0, 8.0, 9.0),
                (11.0, 12.0, 9.0, 11.0),
                (13.0, 14.0, 10.0, 13.0),
                (14.0, 15.0, 12.0, 14.0),
                (8.0, 9.0, 7.0, 8.0),
            ],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], definition.clone());
        assert_eq!(calculation.warmup.required_observations, 2);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_abs_diff_eq!(point_value(&points[1], "sar"), 8.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "direction"), 1.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[2], "sar"), 8.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[3], "sar"), 8.24, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[4], "sar"), 15.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[4], "direction"), -1.0, epsilon = 1e-12);

        let bearish =
            instrument_from_ohlc("asset", &[(11.0, 12.0, 9.0, 11.0), (8.0, 10.0, 7.0, 8.0)]);
        let bearish = calculate_full_with_latest_parity(vec![bearish], definition);
        let point = &bearish.points.unwrap()[1];
        assert_abs_diff_eq!(point_value(point, "sar"), 12.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(point, "direction"), -1.0, epsilon = 1e-12);
    }

    #[test]
    fn choppiness_uses_log_ratio_and_flat_or_single_period_is_neutral() {
        let period_two_definition = with_parameters(
            definition("choppiness", IndicatorKind::ChoppinessIndex, "asset"),
            [("period", json!(2))],
        );
        let asset =
            instrument_from_ohlc("asset", &[(9.0, 10.0, 8.0, 9.0), (10.0, 11.0, 9.0, 10.0)]);
        let calculation =
            calculate_full_with_latest_parity(vec![asset], period_two_definition.clone());
        assert_eq!(calculation.warmup.required_observations, 2);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_abs_diff_eq!(
            point_value(&points[1], "value"),
            100.0 * (4.0_f64 / 3.0).log10() / 2.0_f64.log10(),
            epsilon = 1e-12
        );

        let flat = instrument_from_ohlc("asset", &[(10.0, 10.0, 10.0, 10.0); 2]);
        let flat = calculate_full_with_latest_parity(vec![flat], period_two_definition);
        assert_abs_diff_eq!(
            point_value(&flat.points.unwrap()[1], "value"),
            50.0,
            epsilon = 1e-12
        );

        let one_period = with_parameters(
            definition("one-period", IndicatorKind::ChoppinessIndex, "asset"),
            [("period", json!(1))],
        );
        let one_period = calculate_full_with_latest_parity(
            vec![instrument_from_ohlc("asset", &[(9.0, 10.0, 8.0, 9.0)])],
            one_period,
        );
        assert_abs_diff_eq!(
            point_value(&one_period.points.unwrap()[0], "value"),
            50.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn insufficient_history_full_and_latest_keep_the_same_last_null_state() {
        let asset = instrument_from_closes("asset", &[1.0, 2.0, 3.0]);
        let indicator = with_parameters(
            definition("sma", IndicatorKind::Sma, "asset"),
            [("period", json!(5))],
        );
        let full = calculate(
            vec![asset.clone()],
            indicator.clone(),
            ResponseMode::FullSeries,
        );
        assert_eq!(
            full.availability.status,
            AvailabilityStatus::InsufficientHistory
        );
        assert_eq!(full.availability.reason, "warmup_not_met");
        assert_eq!(full.warmup.state, WarmupState::WarmingUp);
        assert!(full.warmup.first_available_date.is_none());
        let final_full_point = full.points.unwrap().last().unwrap().clone();
        assert_eq!(final_full_point.state, PointState::Warmup);
        assert!(final_full_point.values["value"].is_none());

        let latest = calculate(vec![asset], indicator, ResponseMode::LatestSummary);
        assert_eq!(latest.latest.unwrap(), final_full_point);
    }

    #[test]
    fn volume_sma_and_relative_volume_have_fixed_windows_and_latest_parity() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 12.0, 13.0]),
            &[Some(100.0), Some(200.0), Some(300.0), Some(0.0)],
        );
        let volume_sma = with_parameters(
            definition("volume-sma", IndicatorKind::VolumeSma, "asset"),
            [("period", json!(3))],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset.clone()], volume_sma);
        assert_eq!(
            calculation.availability.status,
            AvailabilityStatus::Available
        );
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_eq!(points[1].state, PointState::Warmup);
        assert_abs_diff_eq!(point_value(&points[2], "value"), 200.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(&points[3], "value"),
            500.0 / 3.0,
            epsilon = 1e-12
        );

        let relative = with_parameters(
            definition("relative-volume", IndicatorKind::RelativeVolume, "asset"),
            [("period", json!(2))],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset], relative);
        assert_eq!(calculation.warmup.required_observations, 3);
        let points = calculation.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_eq!(points[1].state, PointState::Warmup);
        assert_abs_diff_eq!(point_value(&points[2], "value"), 2.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[3], "value"), 0.0, epsilon = 1e-12);
    }

    #[test]
    fn obv_mfi_cmf_and_accumulation_distribution_match_golden_values() {
        let obv_asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 10.0, 10.0, 12.0]),
            &[Some(100.0), Some(200.0), Some(50.0), Some(75.0), Some(25.0)],
        );
        let obv = calculate_full_with_latest_parity(
            vec![obv_asset],
            definition("obv", IndicatorKind::Obv, "asset"),
        );
        assert_eq!(obv.warmup.required_observations, 1);
        assert_eq!(obv.warmup.state, WarmupState::Ready);
        let points = obv.points.unwrap();
        for (point, expected) in points.iter().zip([0.0, 200.0, 150.0, 150.0, 175.0]) {
            assert_abs_diff_eq!(point_value(point, "value"), expected, epsilon = 1e-12);
        }

        let mfi_asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 9.0, 12.0]),
            &[Some(100.0), Some(200.0), Some(300.0), Some(400.0)],
        );
        let mfi = with_parameters(
            definition("mfi", IndicatorKind::Mfi, "asset"),
            [("period", json!(2))],
        );
        let mfi = calculate_full_with_latest_parity(vec![mfi_asset], mfi);
        let points = mfi.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_eq!(points[1].state, PointState::Warmup);
        assert_abs_diff_eq!(
            point_value(&points[2], "value"),
            100.0 * 2_200.0 / 4_900.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(point_value(&points[3], "value"), 64.0, epsilon = 1e-12);

        let flow_asset = with_volumes(
            instrument_from_ohlc(
                "asset",
                &[
                    (7.0, 11.0, 1.0, 8.0),
                    (7.0, 13.0, 3.0, 6.0),
                    (8.0, 8.0, 8.0, 8.0),
                ],
            ),
            &[Some(100.0), Some(200.0), Some(0.0)],
        );
        let cmf = with_parameters(
            definition("cmf", IndicatorKind::Cmf, "asset"),
            [("period", json!(2))],
        );
        let cmf = calculate_full_with_latest_parity(vec![flow_asset.clone()], cmf);
        let points = cmf.points.unwrap();
        assert_eq!(points[0].state, PointState::Warmup);
        assert_abs_diff_eq!(
            point_value(&points[1], "value"),
            -40.0 / 300.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(point_value(&points[2], "value"), -0.4, epsilon = 1e-12);

        let adl = calculate_full_with_latest_parity(
            vec![flow_asset],
            definition("adl", IndicatorKind::AccumulationDistributionLine, "asset"),
        );
        assert_eq!(adl.warmup.required_observations, 1);
        assert_eq!(adl.warmup.state, WarmupState::Ready);
        let points = adl.points.unwrap();
        for (point, expected) in points.iter().zip([40.0, -40.0, -40.0]) {
            assert_abs_diff_eq!(point_value(point, "value"), expected, epsilon = 1e-12);
        }
    }

    #[test]
    fn mixed_null_volume_is_partial_and_only_affected_windows_are_unavailable() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 12.0, 13.0, 14.0, 15.0]),
            &[
                Some(100.0),
                None,
                Some(300.0),
                Some(400.0),
                Some(500.0),
                Some(0.0),
            ],
        );
        let volume_sma = with_parameters(
            definition("volume-sma", IndicatorKind::VolumeSma, "asset"),
            [("period", json!(2))],
        );
        let calculation = calculate_full_with_latest_parity(vec![asset.clone()], volume_sma);
        assert_eq!(calculation.availability.status, AvailabilityStatus::Partial);
        assert_eq!(calculation.availability.reason, "partial_volume_coverage");
        assert_eq!(calculation.warmup.observed_observations, 5);
        let points = calculation.points.unwrap();
        assert_eq!(
            points.iter().map(|point| point.state).collect::<Vec<_>>(),
            vec![
                PointState::Warmup,
                PointState::Unavailable,
                PointState::Unavailable,
                PointState::Available,
                PointState::Available,
                PointState::Available,
            ]
        );
        assert_abs_diff_eq!(point_value(&points[3], "value"), 350.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[5], "value"), 250.0, epsilon = 1e-12);

        let relative = with_parameters(
            definition("relative", IndicatorKind::RelativeVolume, "asset"),
            [("period", json!(2))],
        );
        let relative = calculate_full_with_latest_parity(vec![asset], relative);
        assert_eq!(relative.availability.status, AvailabilityStatus::Partial);
        let points = relative.points.unwrap();
        assert_eq!(points[2].state, PointState::Unavailable);
        assert_eq!(points[3].state, PointState::Unavailable);
        assert_abs_diff_eq!(
            point_value(&points[4], "value"),
            10.0 / 7.0,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(point_value(&points[5], "value"), 0.0, epsilon = 1e-12);
    }

    #[test]
    fn every_stage_three_volume_kind_preserves_nulls_and_accepts_zero_volume() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 9.0, 12.0, 11.0, 13.0]),
            &[
                Some(100.0),
                None,
                Some(300.0),
                Some(400.0),
                Some(0.0),
                Some(600.0),
            ],
        );
        for kind in [
            IndicatorKind::VolumeSma,
            IndicatorKind::RelativeVolume,
            IndicatorKind::Obv,
            IndicatorKind::Mfi,
            IndicatorKind::Cmf,
            IndicatorKind::AccumulationDistributionLine,
        ] {
            let mut indicator = definition(&format!("{kind:?}"), kind, "asset");
            if matches!(
                kind,
                IndicatorKind::VolumeSma
                    | IndicatorKind::RelativeVolume
                    | IndicatorKind::Mfi
                    | IndicatorKind::Cmf
            ) {
                indicator.parameters = BTreeMap::from([("period".into(), json!(2))]);
            }
            let calculation = calculate_full_with_latest_parity(vec![asset.clone()], indicator);
            assert_eq!(
                calculation.availability.status,
                AvailabilityStatus::Partial,
                "{kind:?}"
            );
            let points = calculation.points.unwrap();
            assert!(
                points
                    .iter()
                    .any(|point| point.state == PointState::Available),
                "{kind:?}"
            );
            assert!(
                points
                    .iter()
                    .any(|point| point.state == PointState::Unavailable),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn cumulative_volume_indicators_rebase_each_contiguous_volume_segment() {
        let obv_asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 12.0, 11.0]),
            &[Some(100.0), None, Some(300.0), Some(50.0)],
        );
        let obv = calculate_full_with_latest_parity(
            vec![obv_asset],
            definition("obv", IndicatorKind::Obv, "asset"),
        );
        assert_eq!(obv.availability.status, AvailabilityStatus::Partial);
        let points = obv.points.unwrap();
        assert_abs_diff_eq!(point_value(&points[0], "value"), 0.0, epsilon = 1e-12);
        assert_eq!(points[1].state, PointState::Unavailable);
        assert_abs_diff_eq!(point_value(&points[2], "value"), 0.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[3], "value"), -50.0, epsilon = 1e-12);

        let adl_asset = with_volumes(
            instrument_from_ohlc(
                "asset",
                &[
                    (7.0, 11.0, 1.0, 8.0),
                    (7.0, 11.0, 1.0, 8.0),
                    (7.0, 11.0, 1.0, 8.0),
                    (7.0, 11.0, 1.0, 8.0),
                ],
            ),
            &[Some(100.0), None, Some(300.0), Some(50.0)],
        );
        let adl = calculate_full_with_latest_parity(
            vec![adl_asset],
            definition("adl", IndicatorKind::AccumulationDistributionLine, "asset"),
        );
        assert_eq!(adl.availability.status, AvailabilityStatus::Partial);
        let points = adl.points.unwrap();
        assert_abs_diff_eq!(point_value(&points[0], "value"), 40.0, epsilon = 1e-12);
        assert_eq!(points[1].state, PointState::Unavailable);
        assert_abs_diff_eq!(point_value(&points[2], "value"), 120.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[3], "value"), 140.0, epsilon = 1e-12);
    }

    #[test]
    fn volume_availability_distinguishes_missing_history_and_unsupported_types() {
        let all_missing = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 12.0]),
            &[None, None, None],
        );
        let volume_sma = with_parameters(
            definition("volume-sma", IndicatorKind::VolumeSma, "asset"),
            [("period", json!(2))],
        );
        let calculation =
            calculate_full_with_latest_parity(vec![all_missing.clone()], volume_sma.clone());
        assert_eq!(
            calculation.availability.status,
            AvailabilityStatus::VolumeUnavailable
        );
        assert_eq!(
            calculation.availability.reason,
            "all_volume_observations_missing"
        );
        assert_eq!(calculation.warmup.observed_observations, 0);

        let short = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0]),
            &[Some(100.0), Some(200.0)],
        );
        let long_window = with_parameters(volume_sma.clone(), [("period", json!(3))]);
        let calculation = calculate_full_with_latest_parity(vec![short], long_window);
        assert_eq!(
            calculation.availability.status,
            AvailabilityStatus::InsufficientHistory
        );
        assert_eq!(
            calculation.availability.reason,
            "complete_volume_window_not_available"
        );

        for instrument_type in [
            InstrumentType::Index,
            InstrumentType::Fund,
            InstrumentType::Other,
        ] {
            for kind in [
                IndicatorKind::VolumeSma,
                IndicatorKind::RelativeVolume,
                IndicatorKind::Obv,
                IndicatorKind::Mfi,
                IndicatorKind::Cmf,
                IndicatorKind::AccumulationDistributionLine,
                IndicatorKind::VwapAnchoredVwap,
                IndicatorKind::VolumeProfile,
            ] {
                let mut unsupported = instrument_from_closes("asset", &[10.0, 11.0, 12.0]);
                unsupported.instrument_type = instrument_type;
                let calculation = calculate(
                    vec![unsupported],
                    definition(&format!("{kind:?}"), kind, "asset"),
                    ResponseMode::FullSeries,
                );
                assert_eq!(
                    calculation.availability.status,
                    AvailabilityStatus::UnsupportedInstrument
                );
                assert_eq!(
                    calculation.availability.reason,
                    "volume_indicators_support_stock_and_etf_only"
                );
            }
        }

        let mut etf = instrument_from_closes("asset", &[10.0, 11.0, 12.0]);
        etf.instrument_type = InstrumentType::Etf;
        let calculation = calculate_full_with_latest_parity(vec![etf], volume_sma);
        assert_eq!(
            calculation.availability.status,
            AvailabilityStatus::Available
        );

        let price = calculate_full_with_latest_parity(
            vec![all_missing],
            with_parameters(
                definition("sma", IndicatorKind::Sma, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_eq!(price.availability.status, AvailabilityStatus::Available);
    }

    #[test]
    fn zero_volume_and_flat_price_ranges_use_declared_neutral_values() {
        let zero = with_volumes(
            instrument_from_closes("asset", &[10.0, 10.0, 10.0]),
            &[Some(0.0), Some(0.0), Some(0.0)],
        );
        let relative = calculate_full_with_latest_parity(
            vec![zero.clone()],
            with_parameters(
                definition("relative", IndicatorKind::RelativeVolume, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_eq!(relative.availability.status, AvailabilityStatus::Available);
        assert_abs_diff_eq!(
            point_value(relative.points.unwrap().last().unwrap(), "value"),
            0.0,
            epsilon = 1e-12
        );

        let zero_baseline_spike = with_volumes(
            instrument_from_closes("asset", &[10.0, 10.0, 11.0]),
            &[Some(0.0), Some(0.0), Some(100.0)],
        );
        let relative = calculate_full_with_latest_parity(
            vec![zero_baseline_spike],
            with_parameters(
                definition("relative", IndicatorKind::RelativeVolume, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_eq!(relative.availability.status, AvailabilityStatus::Partial);
        assert_eq!(relative.availability.reason, "partial_calculation_coverage");
        assert_eq!(relative.warmup.state, WarmupState::Ready);
        assert!(relative.warmup.first_available_date.is_none());
        let points = relative.points.unwrap();
        assert_eq!(points[2].state, PointState::Unavailable);
        assert!(points[2].values["value"].is_none());

        let zero_baseline_then_recovery = with_volumes(
            instrument_from_closes("asset", &[10.0, 10.0, 11.0, 12.0]),
            &[Some(0.0), Some(0.0), Some(100.0), Some(100.0)],
        );
        let relative = calculate_full_with_latest_parity(
            vec![zero_baseline_then_recovery],
            with_parameters(
                definition("relative", IndicatorKind::RelativeVolume, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_eq!(relative.availability.status, AvailabilityStatus::Partial);
        assert_eq!(relative.availability.reason, "partial_calculation_coverage");
        let points = relative.points.unwrap();
        assert_eq!(points[2].state, PointState::Unavailable);
        assert!(points[2].values["value"].is_none());
        assert_abs_diff_eq!(point_value(&points[3], "value"), 2.0, epsilon = 1e-12);

        let mfi = calculate_full_with_latest_parity(
            vec![zero.clone()],
            with_parameters(
                definition("mfi", IndicatorKind::Mfi, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_abs_diff_eq!(
            point_value(mfi.points.unwrap().last().unwrap(), "value"),
            50.0,
            epsilon = 1e-12
        );

        let cmf = calculate_full_with_latest_parity(
            vec![zero],
            with_parameters(
                definition("cmf", IndicatorKind::Cmf, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_abs_diff_eq!(
            point_value(cmf.points.unwrap().last().unwrap(), "value"),
            0.0,
            epsilon = 1e-12
        );

        for (closes, expected) in [
            (vec![10.0, 11.0, 12.0], 100.0),
            (vec![12.0, 11.0, 10.0], 0.0),
        ] {
            let one_way_flow = calculate_full_with_latest_parity(
                vec![with_volumes(
                    instrument_from_closes("asset", &closes),
                    &[Some(100.0), Some(100.0), Some(100.0)],
                )],
                with_parameters(
                    definition("mfi-edge", IndicatorKind::Mfi, "asset"),
                    [("period", json!(2))],
                ),
            );
            assert_abs_diff_eq!(
                point_value(one_way_flow.points.unwrap().last().unwrap(), "value"),
                expected,
                epsilon = 1e-12
            );
        }

        let flat_range = with_volumes(
            instrument_from_ohlc(
                "asset",
                &[(10.0, 10.0, 10.0, 10.0), (10.0, 10.0, 10.0, 10.0)],
            ),
            &[Some(100.0), Some(200.0)],
        );
        let flat_cmf = calculate_full_with_latest_parity(
            vec![flat_range.clone()],
            with_parameters(
                definition("flat-cmf", IndicatorKind::Cmf, "asset"),
                [("period", json!(2))],
            ),
        );
        assert_abs_diff_eq!(
            point_value(flat_cmf.points.unwrap().last().unwrap(), "value"),
            0.0,
            epsilon = 1e-12
        );
        let flat_adl = calculate_full_with_latest_parity(
            vec![flat_range],
            definition(
                "flat-adl",
                IndicatorKind::AccumulationDistributionLine,
                "asset",
            ),
        );
        assert!(
            flat_adl
                .points
                .unwrap()
                .iter()
                .all(|point| point_value(point, "value") == 0.0)
        );
    }

    #[test]
    fn stage_four_vwap_and_volume_profile_are_implemented() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 12.0, 14.0]),
            &[Some(100.0), Some(200.0), Some(300.0)],
        );
        let vwap = calculate_full_with_latest_parity(
            vec![asset.clone()],
            with_parameters(
                definition("vwap", IndicatorKind::VwapAnchoredVwap, "asset"),
                [("mode", json!("both")), ("anchor", json!("period_start"))],
            ),
        );
        assert_eq!(vwap.availability.status, AvailabilityStatus::Available);
        let points = vwap.points.unwrap();
        assert_abs_diff_eq!(point_value(&points[0], "vwap"), 10.0, epsilon = 1e-12);
        assert_abs_diff_eq!(point_value(&points[1], "vwap"), 34.0 / 3.0, epsilon = 1e-12);
        assert_abs_diff_eq!(
            point_value(&points[2], "anchored_vwap"),
            76.0 / 6.0,
            epsilon = 1e-12
        );
        assert_eq!(vwap.metadata["future_data_used"], json!(false));

        let profile = calculate(
            vec![asset],
            with_parameters(
                definition("profile", IndicatorKind::VolumeProfile, "asset"),
                [
                    ("bucket_count", json!(5)),
                    ("price_source", json!("close")),
                    ("value_area_percent", json!(70.0)),
                ],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(profile.availability.status, AvailabilityStatus::Available);
        let snapshot = profile.profile.unwrap();
        assert_eq!(snapshot.requested_bucket_count, 5);
        assert_eq!(snapshot.effective_bucket_count, 5);
        assert_eq!(snapshot.buckets.len(), 5);
        assert_abs_diff_eq!(snapshot.total_volume, 600.0, epsilon = 1e-12);
        assert!(
            snapshot
                .buckets
                .iter()
                .any(|bucket| bucket.is_point_of_control)
        );
    }

    #[test]
    fn static_vwap_anchors_resolve_to_the_next_bar_and_never_fabricate_post_range_values() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 20.0, 30.0, 40.0]),
            &[Some(1.0), Some(1.0), Some(1.0), Some(1.0)],
        );
        for anchor in ["user_date", "signal_date"] {
            let calculation = calculate_full_with_latest_parity(
                vec![asset.clone()],
                with_parameters(
                    definition("static-anchor", IndicatorKind::VwapAnchoredVwap, "asset"),
                    [
                        ("anchor", json!(anchor)),
                        ("anchor_date", json!("2024-01-02")),
                        ("mode", json!("anchored")),
                    ],
                ),
            );
            let points = calculation.points.unwrap();
            assert_eq!(points[0].state, PointState::Unavailable);
            assert_abs_diff_eq!(point_value(&points[1], "anchored_vwap"), 20.0);
            assert_abs_diff_eq!(point_value(&points[3], "anchored_vwap"), 30.0);
            assert_eq!(calculation.metadata["requested_anchor_date"], "2024-01-02");
            assert_eq!(calculation.metadata["resolved_anchor_date"], "2024-01-02");

            let vwap_only = calculate(
                vec![asset.clone()],
                with_parameters(
                    definition("vwap-only", IndicatorKind::VwapAnchoredVwap, "asset"),
                    [
                        ("anchor", json!(anchor)),
                        ("anchor_date", json!("2025-01-01")),
                        ("mode", json!("vwap")),
                    ],
                ),
                ResponseMode::FullSeries,
            );
            assert_eq!(vwap_only.availability.status, AvailabilityStatus::Available);
            assert_eq!(vwap_only.availability.reason, "calculated");
            assert_eq!(vwap_only.warmup.required_observations, 1);
            assert_eq!(
                vwap_only.warmup.first_available_date.as_deref(),
                Some("2024-01-01")
            );
            assert_eq!(vwap_only.metadata["anchor_applied"], json!(false));
            assert!(vwap_only.points.unwrap().iter().all(|point| {
                point.state == PointState::Available
                    && point.values["vwap"].is_some()
                    && point.values["anchored_vwap"].is_none()
            }));
        }

        let after_range = calculate(
            vec![asset],
            with_parameters(
                definition("after-range", IndicatorKind::VwapAnchoredVwap, "asset"),
                [
                    ("anchor", json!("user_date")),
                    ("anchor_date", json!("2025-01-01")),
                    ("mode", json!("anchored")),
                ],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(
            after_range.availability,
            Availability {
                status: AvailabilityStatus::InsufficientHistory,
                reason: "anchor_after_last_observation".into(),
            }
        );
        assert!(
            after_range
                .points
                .unwrap()
                .iter()
                .all(|point| point.values["anchored_vwap"].is_none())
        );
    }

    #[test]
    fn recent_extreme_anchors_are_causal_and_future_append_cannot_change_prior_values() {
        for anchor in ["recent_high", "recent_low"] {
            let original = with_volumes(
                instrument_from_closes("asset", &[10.0, 12.0, 11.0, 13.0, 12.0, 14.0]),
                &[Some(10.0); 6],
            );
            let definition = with_parameters(
                definition("causal", IndicatorKind::VwapAnchoredVwap, "asset"),
                [
                    ("anchor", json!(anchor)),
                    ("lookback_period", json!(3)),
                    ("mode", json!("both")),
                ],
            );
            let before = calculate(
                vec![original.clone()],
                definition.clone(),
                ResponseMode::FullSeries,
            );
            assert_eq!(before.availability.status, AvailabilityStatus::Available);
            assert_eq!(before.warmup.required_observations, 3);
            assert_eq!(
                before.warmup.first_available_date.as_deref(),
                Some("2024-01-03")
            );
            let before_points = before.points.as_ref().unwrap();
            assert_eq!(before_points[0].state, PointState::Warmup);
            assert_eq!(before_points[1].state, PointState::Warmup);
            assert!(before_points[..2].iter().all(|point| {
                point.values["vwap"].is_some() && point.values["anchored_vwap"].is_none()
            }));
            assert!(before_points[2..].iter().all(|point| {
                point.state == PointState::Available
                    && point.values["vwap"].is_some()
                    && point.values["anchored_vwap"].is_some()
            }));
            let mut extended = original;
            extended.bars.push(OhlcvBar {
                date: "2024-01-07".into(),
                open: 100.0,
                high: 101.0,
                low: 0.5,
                close: 100.0,
                volume: Some(10.0),
            });
            let after = calculate(vec![extended], definition, ResponseMode::FullSeries);
            assert_eq!(
                before.points.as_ref().unwrap(),
                &after.points.as_ref().unwrap()[..6]
            );
            assert_eq!(before.metadata["future_data_used"], json!(false));
        }

        let short = calculate(
            vec![with_volumes(
                instrument_from_closes("asset", &[10.0, 11.0, 12.0, 13.0]),
                &[Some(10.0); 4],
            )],
            with_parameters(
                definition("short-both", IndicatorKind::VwapAnchoredVwap, "asset"),
                [
                    ("anchor", json!("recent_high")),
                    ("lookback_period", json!(5)),
                    ("mode", json!("both")),
                ],
            ),
            ResponseMode::FullSeries,
        );
        assert_eq!(
            short.availability.status,
            AvailabilityStatus::InsufficientHistory
        );
        assert_eq!(short.warmup.state, WarmupState::WarmingUp);
        assert!(short.warmup.first_available_date.is_none());
        assert!(short.points.unwrap().iter().all(|point| {
            point.state == PointState::Warmup
                && point.values["vwap"].is_some()
                && point.values["anchored_vwap"].is_none()
        }));
    }

    #[test]
    fn vwap_missing_and_zero_volume_are_unavailable_without_fabricated_prices() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 20.0, 30.0, 40.0]),
            &[Some(0.0), None, Some(10.0), Some(10.0)],
        );
        let static_vwap = calculate(
            vec![asset.clone()],
            with_parameters(
                definition("static", IndicatorKind::VwapAnchoredVwap, "asset"),
                [("mode", json!("vwap"))],
            ),
            ResponseMode::FullSeries,
        );
        assert!(
            static_vwap
                .points
                .as_ref()
                .unwrap()
                .iter()
                .all(|point| point.values["vwap"].is_none())
        );
        assert_eq!(
            static_vwap.availability.status,
            AvailabilityStatus::InsufficientHistory
        );

        let causal = calculate(
            vec![asset],
            with_parameters(
                definition("causal", IndicatorKind::VwapAnchoredVwap, "asset"),
                [
                    ("anchor", json!("recent_high")),
                    ("lookback_period", json!(2)),
                    ("mode", json!("anchored")),
                ],
            ),
            ResponseMode::FullSeries,
        );
        let points = causal.points.unwrap();
        assert_eq!(points[1].state, PointState::Unavailable);
        assert_abs_diff_eq!(point_value(&points[2], "anchored_vwap"), 30.0);
        assert_eq!(causal.availability.status, AvailabilityStatus::Partial);
    }

    #[test]
    fn stage_four_rejects_finite_input_arithmetic_overflow() {
        let safe_typical =
            primitives::typical_price(&[f64::MAX], &[f64::MAX], &[f64::MAX]).unwrap();
        assert!(safe_typical[0].is_finite());

        let mut extreme_price = instrument_from_closes("asset", &[10.0]);
        let bar = &mut extreme_price.bars[0];
        bar.open = f64::MAX;
        bar.high = f64::MAX;
        bar.low = f64::MAX;
        bar.close = f64::MAX;
        bar.volume = Some(2.0);
        let vwap_request = TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: ResponseMode::FullSeries,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            instruments: vec![extreme_price],
            indicators: vec![definition("vwap", IndicatorKind::VwapAnchoredVwap, "asset")],
        };
        assert!(
            analyze(&vwap_request, None)
                .unwrap_err()
                .to_string()
                .contains("price-times-volume overflow")
        );

        let profile_request = TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: ResponseMode::FullSeries,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            instruments: vec![with_volumes(
                instrument_from_closes("asset", &[10.0, 11.0]),
                &[Some(f64::MAX), Some(f64::MAX)],
            )],
            indicators: vec![definition("profile", IndicatorKind::VolumeProfile, "asset")],
        };
        assert!(
            analyze(&profile_request, None)
                .unwrap_err()
                .to_string()
                .contains("total volume overflow")
        );
    }

    #[test]
    fn volume_profile_bucket_poc_value_area_flat_missing_and_latest_policies_are_fixed() {
        let asset = with_volumes(
            instrument_from_closes("asset", &[10.0, 11.0, 12.0, 13.0]),
            &[Some(10.0), Some(20.0), Some(30.0), Some(40.0)],
        );
        let profile_definition = with_parameters(
            definition("profile", IndicatorKind::VolumeProfile, "asset"),
            [
                ("bucket_count", json!(5)),
                ("price_source", json!("close")),
                ("value_area_percent", json!(70.0)),
            ],
        );
        let full = calculate(
            vec![asset.clone()],
            profile_definition.clone(),
            ResponseMode::FullSeries,
        );
        let profile = full.profile.as_ref().unwrap();
        assert_eq!(profile.buckets.len(), 5);
        assert_abs_diff_eq!(profile.bucket_width, 0.6, epsilon = 1e-12);
        assert_abs_diff_eq!(profile.point_of_control, 12.7, epsilon = 1e-12);
        assert_abs_diff_eq!(profile.value_area_low, 11.8, epsilon = 1e-12);
        assert_abs_diff_eq!(profile.value_area_high, 13.0, epsilon = 1e-12);
        assert_eq!(
            profile
                .buckets
                .iter()
                .map(|bucket| (bucket.volume, bucket.in_value_area))
                .collect::<Vec<_>>(),
            vec![
                (10.0, false),
                (20.0, false),
                (0.0, false),
                (30.0, true),
                (40.0, true)
            ]
        );

        let latest = calculate(vec![asset], profile_definition, ResponseMode::LatestSummary);
        assert!(latest.points.is_none());
        assert!(latest.profile.as_ref().unwrap().buckets.is_empty());
        assert_eq!(
            latest.metadata["profile_buckets"],
            "omitted_in_latest_summary"
        );

        let flat = calculate(
            vec![with_volumes(
                instrument_from_closes("flat", &[10.0, 10.0, 10.0]),
                &[Some(10.0), Some(20.0), Some(30.0)],
            )],
            with_parameters(
                definition("flat-profile", IndicatorKind::VolumeProfile, "flat"),
                [("bucket_count", json!(24))],
            ),
            ResponseMode::FullSeries,
        );
        let flat_profile = flat.profile.unwrap();
        assert_eq!(flat_profile.requested_bucket_count, 24);
        assert_eq!(flat_profile.effective_bucket_count, 1);
        assert_eq!(flat_profile.buckets.len(), 1);

        let partial = calculate(
            vec![with_volumes(
                instrument_from_closes("partial", &[10.0, 11.0, 12.0]),
                &[Some(10.0), None, Some(30.0)],
            )],
            definition("partial-profile", IndicatorKind::VolumeProfile, "partial"),
            ResponseMode::FullSeries,
        );
        assert_eq!(partial.availability.status, AvailabilityStatus::Partial);
        assert_eq!(partial.profile.unwrap().included_observations, 2);

        let poc_tie = calculate(
            vec![with_volumes(
                instrument_from_closes("tie", &[10.0, 20.0]),
                &[Some(10.0), Some(10.0)],
            )],
            with_parameters(
                definition("tie-profile", IndicatorKind::VolumeProfile, "tie"),
                [("bucket_count", json!(5)), ("price_source", json!("close"))],
            ),
            ResponseMode::FullSeries,
        );
        let poc_tie_profile = poc_tie.profile.unwrap();
        assert_abs_diff_eq!(poc_tie_profile.point_of_control, 19.0, epsilon = 1e-12);
        assert_eq!(
            poc_tie_profile
                .buckets
                .iter()
                .position(|bucket| bucket.is_point_of_control),
            Some(4)
        );
    }

    #[test]
    fn volume_profile_zero_or_missing_volume_and_focused_limits_are_explicit() {
        for (volumes, expected) in [
            (
                vec![None, None, None],
                AvailabilityStatus::VolumeUnavailable,
            ),
            (
                vec![Some(0.0), Some(0.0), Some(0.0)],
                AvailabilityStatus::Partial,
            ),
        ] {
            let calculation = calculate(
                vec![with_volumes(
                    instrument_from_closes("asset", &[10.0, 11.0, 12.0]),
                    &volumes,
                )],
                definition("profile", IndicatorKind::VolumeProfile, "asset"),
                ResponseMode::FullSeries,
            );
            assert_eq!(calculation.availability.status, expected);
            assert!(calculation.profile.is_none());
        }

        let instrument_keys = BTreeSet::from(["asset".to_owned()]);
        let missing_target = IndicatorDefinition {
            instrument_keys: None,
            ..definition("profile", IndicatorKind::VolumeProfile, "asset")
        };
        assert!(
            normalize_definition(&missing_target, &instrument_keys)
                .unwrap_err()
                .to_string()
                .contains("exactly one explicit target")
        );

        let mut multiple_instruments = TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: ResponseMode::FullSeries,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            instruments: vec![instrument("asset"), instrument("other")],
            indicators: vec![definition("profile", IndicatorKind::VolumeProfile, "asset")],
        };
        assert!(
            analyze(&multiple_instruments, None)
                .unwrap_err()
                .to_string()
                .contains("focused request")
        );
        multiple_instruments.instruments.truncate(1);
        multiple_instruments.indicators.push(definition(
            "profile-two",
            IndicatorKind::VolumeProfile,
            "asset",
        ));
        assert!(
            analyze(&multiple_instruments, None)
                .unwrap_err()
                .to_string()
                .contains("at most one")
        );

        let mixed_focused_request = TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: ResponseMode::FullSeries,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            instruments: vec![instrument("asset")],
            indicators: vec![
                definition("profile", IndicatorKind::VolumeProfile, "asset"),
                with_parameters(
                    definition("sma", IndicatorKind::Sma, "asset"),
                    [("period", json!(2))],
                ),
            ],
        };
        assert!(
            analyze(&mixed_focused_request, None)
                .unwrap_err()
                .to_string()
                .contains("exactly one indicator")
        );

        let oversized_bars = (0..=MAX_VOLUME_PROFILE_OBSERVATIONS)
            .map(|index| OhlcvBar {
                date: crate::date::add_days("2000-01-01", index as i64).unwrap(),
                open: 10.0,
                high: 10.0,
                low: 10.0,
                close: 10.0,
                volume: Some(1.0),
            })
            .collect();
        let oversized_request = TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: ResponseMode::FullSeries,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            instruments: vec![InstrumentSeries {
                key: "asset".into(),
                symbol: "asset".into(),
                market: "TEST".into(),
                currency: "KRW".into(),
                instrument_type: InstrumentType::Stock,
                bars: oversized_bars,
            }],
            indicators: vec![definition("profile", IndicatorKind::VolumeProfile, "asset")],
        };
        assert!(
            analyze(&oversized_request, None)
                .unwrap_err()
                .to_string()
                .contains("limited to 20000 observations")
        );

        let maximum = calculate(
            vec![instrument_from_closes("asset", &[10.0, 11.0])],
            with_parameters(
                definition("profile", IndicatorKind::VolumeProfile, "asset"),
                [("bucket_count", json!(MAX_VOLUME_PROFILE_BUCKETS))],
            ),
            ResponseMode::FullSeries,
        );
        assert!(maximum.profile.unwrap().buckets.len() <= MAX_VOLUME_PROFILE_BUCKETS);
    }

    #[test]
    fn prior_observation_indicators_require_one_more_bar_than_the_period() {
        let instrument_keys = BTreeSet::from(["asset".to_owned()]);
        for kind in [
            IndicatorKind::Roc,
            IndicatorKind::HistoricalVolatility,
            IndicatorKind::RelativeVolume,
            IndicatorKind::Mfi,
        ] {
            let normalized = normalize_definition(
                &IndicatorDefinition {
                    id: format!("{kind:?}"),
                    kind,
                    parameters: BTreeMap::from([("period".into(), json!(12))]),
                    instrument_keys: Some(vec!["asset".into()]),
                },
                &instrument_keys,
            )
            .unwrap();
            assert_eq!(normalized.required_observations, 13);
        }
    }

    #[test]
    fn rolling_primitives_have_fixed_population_and_warmup_semantics() {
        let values = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(
            rolling_sum(&values, 3).unwrap(),
            vec![None, None, Some(6.0), Some(9.0)]
        );
        assert_eq!(
            rolling_mean(&values, 3).unwrap(),
            vec![None, None, Some(2.0), Some(3.0)]
        );
        assert_eq!(
            rolling_min(&values, 3).unwrap(),
            vec![None, None, Some(1.0), Some(2.0)]
        );
        assert_eq!(
            rolling_max(&values, 3).unwrap(),
            vec![None, None, Some(3.0), Some(4.0)]
        );
        let standard_deviation = rolling_population_stddev(&values, 3).unwrap();
        assert_abs_diff_eq!(
            standard_deviation[2].unwrap(),
            (2.0_f64 / 3.0).sqrt(),
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            standard_deviation[3].unwrap(),
            (2.0_f64 / 3.0).sqrt(),
            epsilon = 1e-12
        );
        let shifted = rolling_population_stddev(
            &[
                1_000_000_000_001.0,
                1_000_000_000_002.0,
                1_000_000_000_003.0,
            ],
            3,
        )
        .unwrap();
        assert_abs_diff_eq!(shifted[2].unwrap(), (2.0_f64 / 3.0).sqrt(), epsilon = 1e-12);
        let mean_deviation = rolling_mean_absolute_deviation(&values, 3).unwrap();
        assert_abs_diff_eq!(mean_deviation[2].unwrap(), 2.0 / 3.0, epsilon = 1e-12);
        assert_abs_diff_eq!(mean_deviation[3].unwrap(), 2.0 / 3.0, epsilon = 1e-12);
        assert_eq!(rolling_mean(&values, 10).unwrap(), vec![None; 4]);
    }

    #[test]
    fn ema_and_wilder_are_seeded_by_the_first_period_sma() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0];
        let exponential = ema(&values, 3).unwrap();
        assert_eq!(exponential[..2], [None, None]);
        assert_abs_diff_eq!(exponential[2].unwrap(), 2.0, epsilon = 1e-12);
        assert_abs_diff_eq!(exponential[3].unwrap(), 3.0, epsilon = 1e-12);
        assert_abs_diff_eq!(exponential[4].unwrap(), 4.0, epsilon = 1e-12);

        let wilder = wilder_smoothing(&values, 3).unwrap();
        assert_eq!(wilder[..2], [None, None]);
        assert_abs_diff_eq!(wilder[2].unwrap(), 2.0, epsilon = 1e-12);
        assert_abs_diff_eq!(wilder[3].unwrap(), 8.0 / 3.0, epsilon = 1e-12);
        assert_abs_diff_eq!(wilder[4].unwrap(), 31.0 / 9.0, epsilon = 1e-12);
    }

    #[test]
    fn true_range_and_typical_price_follow_declared_ohlc_policy() {
        let high = [10.0, 12.0, 11.0];
        let low = [8.0, 9.0, 7.0];
        let close = [9.0, 10.0, 8.0];
        assert_eq!(
            true_range(&high, &low, &close).unwrap(),
            vec![2.0, 3.0, 4.0]
        );
        let typical = typical_price(&high, &low, &close).unwrap();
        assert_abs_diff_eq!(typical[0], 9.0, epsilon = 1e-12);
        assert_abs_diff_eq!(typical[1], 31.0 / 3.0, epsilon = 1e-12);
        assert_abs_diff_eq!(typical[2], 26.0 / 3.0, epsilon = 1e-12);
    }

    #[test]
    fn primitives_reject_zero_period_mismatched_lengths_and_non_finite_input() {
        assert!(rolling_mean(&[1.0], 0).is_err());
        assert!(rolling_sum(&[f64::NAN], 1).is_err());
        assert!(ema(&[1.0, f64::INFINITY], 2).is_err());
        assert!(true_range(&[2.0], &[1.0, 2.0], &[1.5]).is_err());
        assert!(typical_price(&[0.5], &[1.0], &[0.75]).is_err());
    }
}
