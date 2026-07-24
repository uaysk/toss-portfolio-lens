use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::control::{ComputeControl, checkpoint};
use crate::date::{civil_from_days, epoch_day, parse_iso_date};
use crate::indicators::{
    AdjustmentPolicy, Availability, AvailabilityStatus, INDICATOR_ENGINE_VERSION,
    IndicatorCalculation, IndicatorDefinition, IndicatorKind, InstrumentSeries, InstrumentType,
    OhlcvBar, PointState, ResponseMode, TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION,
    TechnicalAnalysisRequest, VolumeProfileBucket, analyze,
};
use crate::stats::round;

pub const SCALPING_ENGINE_VERSION: &str = "scalping-analysis/1.4.0";
pub const SCALPING_REQUEST_SCHEMA_VERSION: &str = "scalping-analysis-request/v3";
pub const SCALPING_RESULT_SCHEMA_VERSION: &str = "scalping-analysis-result/v3";

const MAX_INSTRUMENTS: usize = 50;
const MAX_BARS_PER_INSTRUMENT: usize = 100_000;
const MAX_TOTAL_BARS: usize = 2_000_000;
const MAX_INDICATORS: usize = 256;
const MAX_PROFILE_INSTRUMENTS: usize = 20;
const MAX_PROFILE_OBSERVATIONS: usize = 20_000;
const MAX_OUTPUT_SERIES_TAIL_POINTS: usize = 512;
const DEFAULT_OUTPUT_SERIES_TAIL_POINTS: usize = 180;
const MAX_SIGNAL_SNAPSHOT_POINTS: usize = 100_000;
const MAX_OUTPUT_SERIALIZATION_UNITS: usize = 300_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignalPreset {
    Trend,
    Breakout,
    MeanReversion,
    RiskManagement,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistanceStatus {
    Watch,
    EntryCandidate,
    Hold,
    ExitCandidate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrendDirection {
    Bullish,
    Bearish,
    Neutral,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MinuteBar {
    pub timestamp: String,
    pub session_date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OrderBookSnapshot {
    pub timestamp: String,
    pub bid_volume: f64,
    pub ask_volume: f64,
    #[serde(default)]
    pub best_bid: Option<f64>,
    #[serde(default)]
    pub best_ask: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TradeStatsSnapshot {
    pub timestamp: String,
    pub buy_volume: f64,
    pub sell_volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PositionSnapshot {
    pub as_of_timestamp: String,
    pub quantity: f64,
    #[serde(default)]
    pub average_price: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionWindow {
    pub kind: String,
    pub open_minute: u32,
    pub close_minute: u32,
    #[serde(default)]
    pub local_date_offset: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionWindowOverride {
    pub session_date: String,
    pub windows: Vec<SessionWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingInstrument {
    pub key: String,
    pub symbol: String,
    pub market: String,
    pub currency: String,
    pub instrument_type: InstrumentType,
    pub bars: Vec<MinuteBar>,
    #[serde(default)]
    pub session_start_confirmed_dates: Vec<String>,
    #[serde(default)]
    pub complete_session_dates: Vec<String>,
    #[serde(default)]
    pub session_windows: Vec<SessionWindow>,
    #[serde(default)]
    pub session_window_overrides: Vec<SessionWindowOverride>,
    #[serde(default)]
    pub anchored_vwap_timestamp: Option<String>,
    #[serde(default)]
    pub next_valid_quote_timestamp: Option<String>,
    #[serde(default)]
    pub orderbook: Option<OrderBookSnapshot>,
    #[serde(default)]
    pub trade_stats: Option<TradeStatsSnapshot>,
    #[serde(default)]
    pub position: Option<PositionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VolumeProfileConfig {
    pub instrument_keys: Vec<String>,
    pub bucket_count: usize,
    pub value_area_percent: f64,
    pub price_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignalSnapshotSelection {
    pub instrument_key: String,
    pub timestamps: Vec<String>,
}

fn default_output_series_tail_points() -> usize {
    DEFAULT_OUTPUT_SERIES_TAIL_POINTS
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingOutputProjection {
    #[serde(default = "default_output_series_tail_points")]
    pub series_tail_points: usize,
    #[serde(default)]
    pub signal_snapshots: Vec<SignalSnapshotSelection>,
}

impl Default for ScalpingOutputProjection {
    fn default() -> Self {
        Self {
            series_tail_points: DEFAULT_OUTPUT_SERIES_TAIL_POINTS,
            signal_snapshots: Vec::new(),
        }
    }
}

fn default_relative_volume_lookback_sessions() -> usize {
    5
}

fn default_true() -> bool {
    true
}

fn default_entry_buffer_bps() -> f64 {
    15.0
}

fn default_stop_loss_bps() -> f64 {
    100.0
}

fn default_target_reward_ratio() -> f64 {
    2.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SignalConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub preset: SignalPreset,
    #[serde(default = "default_entry_buffer_bps")]
    pub entry_buffer_bps: f64,
    #[serde(default = "default_stop_loss_bps")]
    pub stop_loss_bps: f64,
    #[serde(default = "default_target_reward_ratio")]
    pub target_reward_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingAnalysisRequest {
    pub schema_version: String,
    pub response_mode: ResponseMode,
    pub adjustment_policy: AdjustmentPolicy,
    pub interval_minutes: u32,
    pub instruments: Vec<ScalpingInstrument>,
    #[serde(default)]
    pub indicators: Vec<IndicatorDefinition>,
    #[serde(default = "default_relative_volume_lookback_sessions")]
    pub relative_volume_lookback_sessions: usize,
    #[serde(default)]
    pub volume_profile: Option<VolumeProfileConfig>,
    #[serde(default)]
    pub signal: Option<SignalConfig>,
    #[serde(default)]
    pub output_projection: ScalpingOutputProjection,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingIndicatorPoint {
    pub timestamp: String,
    pub state: PointState,
    pub values: BTreeMap<String, Option<f64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingWarmupMetadata {
    pub required_observations: usize,
    pub observed_observations: usize,
    pub state: crate::indicators::WarmupState,
    pub first_available_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingVolumeProfile {
    pub schema_version: String,
    pub from_timestamp: String,
    pub to_timestamp: String,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingVolumeProfileOutput {
    pub availability: Availability,
    pub metadata: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<ScalpingVolumeProfile>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingIndicatorCalculation {
    pub instrument_key: String,
    pub indicator_id: String,
    pub kind: IndicatorKind,
    pub parameters: BTreeMap<String, Value>,
    pub availability: Availability,
    pub warmup: ScalpingWarmupMetadata,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<ScalpingVolumeProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<ScalpingIndicatorPoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<ScalpingIndicatorPoint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IntradayMetricPoint {
    pub timestamp: String,
    pub state: PointState,
    pub values: BTreeMap<String, Option<f64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IntradayMetricSeries {
    pub availability: Availability,
    pub metadata: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<IntradayMetricPoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<IntradayMetricPoint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SnapshotMetric {
    pub availability: Availability,
    pub timestamp: Option<String>,
    pub values: BTreeMap<String, Option<f64>>,
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IntradayMetrics {
    pub session_vwap: IntradayMetricSeries,
    pub anchored_vwap: IntradayMetricSeries,
    pub opening_range_5: IntradayMetricSeries,
    pub opening_range_15: IntradayMetricSeries,
    pub opening_range_30: IntradayMetricSeries,
    pub time_of_day_relative_volume: IntradayMetricSeries,
    pub previous_session_levels: IntradayMetricSeries,
    pub current_session_levels: IntradayMetricSeries,
    pub orderbook_imbalance: SnapshotMetric,
    pub execution_strength: SnapshotMetric,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PriceRange {
    pub low: f64,
    pub high: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssistanceSignal {
    pub instrument_key: String,
    pub status: AssistanceStatus,
    pub calculation_timestamp: String,
    pub signal_timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earliest_eligible_timestamp: Option<String>,
    pub eligibility_basis: String,
    pub basis_price: f64,
    pub expected_entry_range: Option<PriceRange>,
    pub stop_candidate_price: Option<f64>,
    pub target_price_range: Option<PriceRange>,
    pub expected_reward_risk_ratio: Option<f64>,
    pub indicators: Vec<String>,
    pub multi_timeframe_trends: BTreeMap<String, Option<TrendDirection>>,
    pub multi_timeframe_agreement: String,
    pub confidence: f64,
    pub confidence_semantics: String,
    pub data_quality: Availability,
    pub position_known: bool,
    pub rationale: Vec<String>,
    pub disclaimer: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssistanceSignalSeries {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<AssistanceSignal>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<AssistanceSignal>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingSignalSnapshot {
    pub calculation_timestamp: String,
    pub technical_signal: i8,
    pub multi_timeframe_agreement: String,
    pub basis_price: f64,
    pub stop_candidate_price: Option<f64>,
    pub target_candidate_price: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingDataQuality {
    pub status: AvailabilityStatus,
    pub final_bar_count: usize,
    pub same_session_gap_count: usize,
    pub missing_volume_count: usize,
    pub missing_amount_count: usize,
    pub orderbook_history: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScannerMetric {
    pub availability: Availability,
    pub value: Option<f64>,
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScannerMetrics {
    pub realized_volatility: ScannerMetric,
    pub normalized_atr: ScannerMetric,
    pub day_range_ratio: ScannerMetric,
    pub bollinger_width_expansion: ScannerMetric,
    pub relative_volume: ScannerMetric,
    pub trading_amount: ScannerMetric,
    pub spread_bps: ScannerMetric,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingInstrumentResult {
    pub instrument_key: String,
    pub interval_minutes: u32,
    pub bar_count: usize,
    pub indicators: Vec<ScalpingIndicatorCalculation>,
    pub intraday: IntradayMetrics,
    pub volume_profile: Option<ScalpingVolumeProfileOutput>,
    pub signals: Option<AssistanceSignalSeries>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub signal_snapshots: Vec<ScalpingSignalSnapshot>,
    pub scanner_metrics: ScannerMetrics,
    pub data_quality: ScalpingDataQuality,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingDiagnostics {
    pub validation: String,
    pub timestamp_policy: String,
    pub bar_policy: String,
    pub indicator_reuse: String,
    pub session_vwap_policy: String,
    pub relative_volume_policy: String,
    pub signal_execution_policy: String,
    pub orderbook_history_policy: String,
    pub output_projection_policy: String,
    pub series_tail_points: usize,
    pub signal_snapshot_count: usize,
    pub instrument_count: usize,
    pub indicator_definition_count: usize,
    pub total_bar_count: usize,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScalpingAnalysisResult {
    pub schema_version: String,
    pub scalping_engine_version: String,
    pub indicator_engine_version: String,
    pub response_mode: ResponseMode,
    pub interval_minutes: u32,
    pub instruments: Vec<ScalpingInstrumentResult>,
    pub diagnostics: ScalpingDiagnostics,
}

#[derive(Debug, Clone)]
struct ParsedTimestamp {
    epoch_millis: i64,
    local_epoch_day: i64,
    local_minute_of_day: u32,
}

struct TranslatedRequest {
    technical_request: Option<TechnicalAnalysisRequest>,
    local_timestamps: BTreeMap<String, BTreeMap<String, String>>,
    global_timestamps: BTreeMap<String, String>,
    instruments: Vec<InstrumentSeries>,
}

fn parse_two(source: &str, start: usize, label: &str) -> Result<u32> {
    source
        .get(start..start + 2)
        .with_context(|| label.to_owned())?
        .parse::<u32>()
        .with_context(|| label.to_owned())
}

fn parse_timestamp(value: &str) -> Result<ParsedTimestamp> {
    ensure!(value.is_ascii(), "timestamp must be ASCII RFC3339");
    ensure!(value.len() >= 20, "timestamp must be RFC3339");
    ensure!(
        value.as_bytes().get(10) == Some(&b'T'),
        "timestamp must use RFC3339 T separator"
    );
    let date = value.get(0..10).context("timestamp date is missing")?;
    let day = epoch_day(date).context("timestamp date must be a valid ISO date")?;
    let hour = parse_two(value, 11, "timestamp hour is invalid")?;
    let minute = parse_two(value, 14, "timestamp minute is invalid")?;
    let second = parse_two(value, 17, "timestamp second is invalid")?;
    ensure!(
        value.as_bytes().get(13) == Some(&b':') && value.as_bytes().get(16) == Some(&b':'),
        "timestamp time separators are invalid"
    );
    ensure!(
        hour < 24 && minute < 60 && second < 60,
        "timestamp time is out of range"
    );
    let suffix = value.get(19..).context("timestamp timezone is missing")?;
    let (fraction_millis, timezone) = if let Some(fraction) = suffix.strip_prefix('.') {
        let timezone_index = fraction
            .find(['Z', '+', '-'])
            .context("timestamp timezone is missing")?;
        let digits = &fraction[..timezone_index];
        ensure!(
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()),
            "timestamp fractional seconds are invalid"
        );
        let milliseconds = format!("{digits:0<3}")
            .get(..3)
            .context("timestamp fractional seconds are invalid")?
            .parse::<i64>()?;
        (milliseconds, &fraction[timezone_index..])
    } else {
        (0_i64, suffix)
    };
    let offset_seconds = if timezone == "Z" {
        0_i64
    } else {
        ensure!(timezone.len() == 6, "timestamp timezone offset is invalid");
        let sign = match timezone.as_bytes()[0] {
            b'+' => 1_i64,
            b'-' => -1_i64,
            _ => bail!("timestamp timezone offset is invalid"),
        };
        ensure!(
            timezone.as_bytes()[3] == b':',
            "timestamp timezone offset is invalid"
        );
        let offset_hour = timezone[1..3].parse::<u32>()?;
        let offset_minute = timezone[4..6].parse::<u32>()?;
        ensure!(
            offset_hour <= 23 && offset_minute < 60,
            "timestamp timezone offset is out of range"
        );
        sign * i64::from(offset_hour * 3_600 + offset_minute * 60)
    };
    let seconds = day
        .checked_mul(86_400)
        .and_then(|value| value.checked_add(i64::from(hour * 3_600 + minute * 60 + second)))
        .and_then(|value| value.checked_sub(offset_seconds))
        .context("timestamp is outside supported range")?;
    Ok(ParsedTimestamp {
        epoch_millis: seconds
            .checked_mul(1_000)
            .and_then(|value| value.checked_add(fraction_millis))
            .context("timestamp is outside supported range")?,
        local_epoch_day: day,
        local_minute_of_day: hour * 60 + minute,
    })
}

fn window_effective_open(window: &SessionWindow) -> i32 {
    window.local_date_offset * 24 * 60 + window.open_minute as i32
}

fn window_effective_close(window: &SessionWindow) -> i32 {
    window.local_date_offset * 24 * 60 + window.close_minute as i32
}

fn last_complete_minute(window: &SessionWindow, interval_minutes: u32) -> Option<i32> {
    let count = (window.close_minute - window.open_minute) / interval_minutes;
    (count > 0).then_some(window_effective_open(window) + (count * interval_minutes) as i32)
}

fn session_windows_for_date<'a>(
    instrument: &'a ScalpingInstrument,
    session_date: &str,
) -> &'a [SessionWindow] {
    instrument
        .session_window_overrides
        .iter()
        .find(|schedule| schedule.session_date == session_date)
        .map_or(instrument.session_windows.as_slice(), |schedule| {
            schedule.windows.as_slice()
        })
}

fn has_configured_session_windows(instrument: &ScalpingInstrument) -> bool {
    !instrument.session_windows.is_empty() || !instrument.session_window_overrides.is_empty()
}

fn effective_session_minute(parsed: &ParsedTimestamp, session_date: &str) -> Result<i32> {
    let session_day = epoch_day(session_date).context("session_date must be a valid ISO date")?;
    let day_delta = parsed
        .local_epoch_day
        .checked_sub(session_day)
        .context("session-date offset overflow")?;
    let effective = day_delta
        .checked_mul(24 * 60)
        .and_then(|value| value.checked_add(i64::from(parsed.local_minute_of_day)))
        .context("effective session minute overflow")?;
    i32::try_from(effective).context("effective session minute is outside supported range")
}

fn has_scheduled_window_tail(instrument: &ScalpingInstrument, interval_minutes: u32) -> bool {
    instrument
        .session_windows
        .iter()
        .chain(
            instrument
                .session_window_overrides
                .iter()
                .flat_map(|schedule| schedule.windows.iter()),
        )
        .any(|window| (window.close_minute - window.open_minute) % interval_minutes != 0)
}

fn session_window_index(
    windows: &[SessionWindow],
    effective_minute: i32,
    interval_minutes: u32,
) -> Option<usize> {
    windows.iter().position(|window| {
        let open = window_effective_open(window);
        let close = window_effective_close(window);
        effective_minute > open
            && effective_minute <= close
            && (effective_minute - open) % interval_minutes as i32 == 0
    })
}

fn is_scheduled_session_transition(
    instrument: &ScalpingInstrument,
    previous: &MinuteBar,
    current: &MinuteBar,
    interval_minutes: u32,
) -> Result<bool> {
    if previous.session_date != current.session_date {
        return Ok(false);
    }
    let windows = session_windows_for_date(instrument, &previous.session_date);
    if windows.is_empty() {
        return Ok(false);
    }
    let previous_time = parse_timestamp(&previous.timestamp)?;
    let current_time = parse_timestamp(&current.timestamp)?;
    let previous_minute = effective_session_minute(&previous_time, &previous.session_date)?;
    let current_minute = effective_session_minute(&current_time, &current.session_date)?;
    let Some(previous_index) = session_window_index(windows, previous_minute, interval_minutes)
    else {
        return Ok(false);
    };
    let Some(current_index) = session_window_index(windows, current_minute, interval_minutes)
    else {
        return Ok(false);
    };
    if current_index != previous_index + 1 {
        return Ok(false);
    }
    let previous_window = &windows[previous_index];
    let current_window = &windows[current_index];
    Ok(
        last_complete_minute(previous_window, interval_minutes) == Some(previous_minute)
            && current_minute == window_effective_open(current_window) + interval_minutes as i32,
    )
}

fn is_unexpected_same_session_gap(
    instrument: &ScalpingInstrument,
    previous: &MinuteBar,
    current: &MinuteBar,
    interval_minutes: u32,
) -> Result<bool> {
    if previous.session_date != current.session_date {
        return Ok(false);
    }
    let previous_epoch = parse_timestamp(&previous.timestamp)?.epoch_millis;
    let current_epoch = parse_timestamp(&current.timestamp)?.epoch_millis;
    Ok(
        current_epoch - previous_epoch > i64::from(interval_minutes) * 60_000
            && !is_scheduled_session_transition(instrument, previous, current, interval_minutes)?,
    )
}

fn unexpected_gap_in_validated_request(
    instrument: &ScalpingInstrument,
    previous: &MinuteBar,
    current: &MinuteBar,
    interval_minutes: u32,
) -> bool {
    is_unexpected_same_session_gap(instrument, previous, current, interval_minutes)
        .expect("validated scalping timestamps and session windows")
}

fn next_scheduled_close_epoch(
    instrument: &ScalpingInstrument,
    bar: &MinuteBar,
    interval_minutes: u32,
) -> Result<Option<i64>> {
    let windows = session_windows_for_date(instrument, &bar.session_date);
    if windows.is_empty() {
        return Ok(None);
    }
    let parsed = parse_timestamp(&bar.timestamp)?;
    let effective_minute = effective_session_minute(&parsed, &bar.session_date)?;
    let Some(index) = session_window_index(windows, effective_minute, interval_minutes) else {
        return Ok(None);
    };
    let window = &windows[index];
    let next_minute =
        if effective_minute + interval_minutes as i32 <= window_effective_close(window) {
            Some(effective_minute + interval_minutes as i32)
        } else {
            windows.get(index + 1).and_then(|next| {
                last_complete_minute(next, interval_minutes)
                    .map(|_| window_effective_open(next) + interval_minutes as i32)
            })
        };
    Ok(next_minute
        .map(|minute| parsed.epoch_millis + i64::from(minute - effective_minute) * 60_000))
}

fn format_utc_timestamp(epoch_millis: i64) -> String {
    let seconds = epoch_millis.div_euclid(1_000);
    let millis = epoch_millis.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}Z",
        civil_from_days(days),
        remainder / 3_600,
        remainder % 3_600 / 60,
        remainder % 60,
        millis
    )
}

fn non_empty_bounded(value: &str, maximum: usize, label: &str) -> Result<()> {
    ensure!(!value.trim().is_empty(), "{label} must not be empty");
    ensure!(value.len() <= maximum, "{label} exceeds {maximum} bytes");
    ensure!(
        value == value.trim(),
        "{label} must not have surrounding whitespace"
    );
    Ok(())
}

fn validate_snapshot_timestamp(value: &str, label: &str) -> Result<i64> {
    parse_timestamp(value)
        .with_context(|| format!("{label} must be a valid RFC3339 timestamp"))
        .map(|parsed| parsed.epoch_millis)
}

fn validate_session_windows(
    instrument_key: &str,
    windows: &[SessionWindow],
    label: &str,
) -> Result<()> {
    ensure!(
        windows.len() <= 16,
        "instrument {instrument_key} {label} must contain at most 16 items"
    );
    let mut previous_window_close: Option<i32> = None;
    for window in windows {
        non_empty_bounded(&window.kind, 32, "session window kind")?;
        ensure!(
            matches!(window.local_date_offset, -1 | 0),
            "instrument {instrument_key} {label} local_date_offset is invalid"
        );
        ensure!(
            window.open_minute < window.close_minute && window.close_minute <= 24 * 60,
            "instrument {instrument_key} {label} minute range is invalid"
        );
        let effective_open = window_effective_open(window);
        let effective_close = window_effective_close(window);
        ensure!(
            previous_window_close.is_none_or(|close| effective_open >= close),
            "instrument {instrument_key} {label} must be sorted and non-overlapping"
        );
        previous_window_close = Some(effective_close);
    }
    Ok(())
}

fn validate_request(request: &ScalpingAnalysisRequest) -> Result<()> {
    ensure!(
        request.schema_version == SCALPING_REQUEST_SCHEMA_VERSION,
        "unsupported scalping analysis request schema version: {}",
        request.schema_version
    );
    ensure!(
        matches!(request.interval_minutes, 1 | 5 | 15 | 30 | 60),
        "scalping interval_minutes must be one of 1, 5, 15, 30, or 60"
    );
    ensure!(
        (1..=MAX_INSTRUMENTS).contains(&request.instruments.len()),
        "scalping instruments must contain 1..={MAX_INSTRUMENTS} items"
    );
    ensure!(
        request.indicators.len() <= MAX_INDICATORS,
        "scalping indicators exceed {MAX_INDICATORS} definitions"
    );
    ensure!(
        (1..=60).contains(&request.relative_volume_lookback_sessions),
        "relative_volume_lookback_sessions must be in 1..=60"
    );
    ensure!(
        request
            .indicators
            .iter()
            .all(|definition| definition.kind != IndicatorKind::VolumeProfile),
        "volume_profile must use the bounded scalping volume_profile request"
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
            "scalping instrument keys must be unique"
        );
        ensure!(
            (1..=MAX_BARS_PER_INSTRUMENT).contains(&instrument.bars.len()),
            "instrument {} bars must contain 1..={MAX_BARS_PER_INSTRUMENT} items",
            instrument.key
        );
        total_bars = total_bars
            .checked_add(instrument.bars.len())
            .context("scalping total bar count overflow")?;
        ensure!(
            total_bars <= MAX_TOTAL_BARS,
            "scalping total bars exceed {MAX_TOTAL_BARS}"
        );
        validate_session_windows(
            &instrument.key,
            &instrument.session_windows,
            "session_windows",
        )?;
        ensure!(
            instrument.session_window_overrides.len() <= 400,
            "instrument {} session_window_overrides must contain at most 400 items",
            instrument.key
        );
        let mut override_dates = BTreeSet::new();
        for schedule in &instrument.session_window_overrides {
            parse_iso_date(&schedule.session_date).with_context(|| {
                format!(
                    "instrument {} has invalid session-window override date {}",
                    instrument.key, schedule.session_date
                )
            })?;
            ensure!(
                override_dates.insert(schedule.session_date.as_str()),
                "instrument {} session-window override dates must be unique",
                instrument.key
            );
            ensure!(
                !schedule.windows.is_empty(),
                "instrument {} session-window override must not be empty",
                instrument.key
            );
            validate_session_windows(
                &instrument.key,
                &schedule.windows,
                "session_window_overrides.windows",
            )?;
        }
        let mut previous_epoch = None;
        let mut previous_session: Option<&str> = None;
        let mut previous_bar: Option<&MinuteBar> = None;
        for bar in &instrument.bars {
            ensure!(
                bar.complete,
                "instrument {} accepts finalized bars only; {} is still forming",
                instrument.key,
                bar.timestamp
            );
            parse_iso_date(&bar.session_date).with_context(|| {
                format!(
                    "instrument {} has invalid session_date {}",
                    instrument.key, bar.session_date
                )
            })?;
            let parsed = parse_timestamp(&bar.timestamp).with_context(|| {
                format!(
                    "instrument {} has invalid bar timestamp {}",
                    instrument.key, bar.timestamp
                )
            })?;
            ensure!(
                parsed.epoch_millis.rem_euclid(60_000) == 0,
                "instrument {} minute bars must end on an exact minute at {}",
                instrument.key,
                bar.timestamp
            );
            let windows = session_windows_for_date(instrument, &bar.session_date);
            if windows.is_empty() {
                ensure!(
                    bar.timestamp.get(..10) == Some(bar.session_date.as_str()),
                    "instrument {} session_date must match the timestamp local calendar date when no windows are configured at {}",
                    instrument.key,
                    bar.timestamp
                );
            } else {
                let effective_minute = effective_session_minute(&parsed, &bar.session_date)?;
                ensure!(
                    session_window_index(windows, effective_minute, request.interval_minutes)
                        .is_some(),
                    "instrument {} bar timestamp is outside configured session windows at {}",
                    instrument.key,
                    bar.timestamp
                );
            }
            if let Some(previous) = previous_epoch {
                ensure!(
                    previous < parsed.epoch_millis,
                    "instrument {} bars must be strictly timestamp-ascending without duplicates",
                    instrument.key
                );
                if previous_session == Some(bar.session_date.as_str()) {
                    let gap_minutes = (parsed.epoch_millis - previous) / 60_000;
                    ensure!(
                        gap_minutes >= i64::from(request.interval_minutes)
                            && (gap_minutes % i64::from(request.interval_minutes) == 0
                                || previous_bar.is_some_and(|previous_bar| {
                                    is_scheduled_session_transition(
                                        instrument,
                                        previous_bar,
                                        bar,
                                        request.interval_minutes,
                                    )
                                    .unwrap_or(false)
                                })),
                        "instrument {} same-session bar timestamps must align to the selected interval",
                        instrument.key
                    );
                }
            }
            if let Some(previous) = previous_session {
                ensure!(
                    previous <= bar.session_date.as_str(),
                    "instrument {} session dates must be non-decreasing",
                    instrument.key
                );
            }
            ensure!(
                [bar.open, bar.high, bar.low, bar.close]
                    .iter()
                    .all(|value| value.is_finite() && *value > 0.0),
                "instrument {} OHLC values must be finite and positive at {}",
                instrument.key,
                bar.timestamp
            );
            ensure!(
                bar.high >= bar.open.max(bar.close).max(bar.low)
                    && bar.low <= bar.open.min(bar.close).min(bar.high),
                "instrument {} OHLC range is inconsistent at {}",
                instrument.key,
                bar.timestamp
            );
            ensure!(
                bar.volume
                    .is_none_or(|value| value.is_finite() && value >= 0.0),
                "instrument {} volume must be finite and non-negative at {}",
                instrument.key,
                bar.timestamp
            );
            ensure!(
                bar.amount
                    .is_none_or(|value| value.is_finite() && value >= 0.0),
                "instrument {} amount must be finite and non-negative at {}",
                instrument.key,
                bar.timestamp
            );
            previous_epoch = Some(parsed.epoch_millis);
            previous_session = Some(&bar.session_date);
            previous_bar = Some(bar);
        }
        let last_epoch = previous_epoch.expect("validated non-empty bars");
        let supplied_sessions = instrument
            .bars
            .iter()
            .map(|bar| bar.session_date.as_str())
            .collect::<BTreeSet<_>>();
        for (label, dates) in [
            (
                "session_start_confirmed_dates",
                &instrument.session_start_confirmed_dates,
            ),
            ("complete_session_dates", &instrument.complete_session_dates),
        ] {
            ensure!(
                dates.len() == dates.iter().collect::<BTreeSet<_>>().len(),
                "instrument {} {label} must not contain duplicates",
                instrument.key
            );
            for date in dates {
                parse_iso_date(date).with_context(|| {
                    format!(
                        "instrument {} {label} contains invalid date {date}",
                        instrument.key
                    )
                })?;
                ensure!(
                    supplied_sessions.contains(date.as_str()),
                    "instrument {} {label} references a session without supplied bars",
                    instrument.key
                );
            }
        }
        let starts = instrument
            .session_start_confirmed_dates
            .iter()
            .collect::<BTreeSet<_>>();
        ensure!(
            instrument
                .complete_session_dates
                .iter()
                .all(|date| starts.contains(date)),
            "instrument {} complete_session_dates must be a subset of session_start_confirmed_dates",
            instrument.key
        );
        if let Some(anchor) = &instrument.anchored_vwap_timestamp {
            validate_snapshot_timestamp(anchor, "anchored_vwap_timestamp")?;
        }
        let next_quote_epoch = instrument
            .next_valid_quote_timestamp
            .as_deref()
            .map(|next_quote| validate_snapshot_timestamp(next_quote, "next_valid_quote_timestamp"))
            .transpose()?;
        if let Some(next_quote_epoch) = next_quote_epoch {
            ensure!(
                next_quote_epoch > last_epoch,
                "instrument {} next_valid_quote_timestamp must be after the last finalized bar",
                instrument.key
            );
        }
        if let Some(snapshot) = &instrument.orderbook {
            validate_snapshot_timestamp(&snapshot.timestamp, "orderbook timestamp")?;
            ensure!(
                snapshot.bid_volume.is_finite()
                    && snapshot.bid_volume >= 0.0
                    && snapshot.ask_volume.is_finite()
                    && snapshot.ask_volume >= 0.0,
                "instrument {} orderbook volumes must be finite and non-negative",
                instrument.key
            );
            ensure!(
                snapshot.best_bid.is_some() == snapshot.best_ask.is_some(),
                "instrument {} orderbook best_bid and best_ask must be supplied together",
                instrument.key
            );
            if let (Some(bid), Some(ask)) = (snapshot.best_bid, snapshot.best_ask) {
                ensure!(
                    bid.is_finite() && bid > 0.0 && ask.is_finite() && ask >= bid,
                    "instrument {} orderbook best prices must be positive with best_ask >= best_bid",
                    instrument.key
                );
            }
        }
        if let Some(snapshot) = &instrument.trade_stats {
            validate_snapshot_timestamp(&snapshot.timestamp, "trade stats timestamp")?;
            ensure!(
                snapshot.buy_volume.is_finite()
                    && snapshot.buy_volume >= 0.0
                    && snapshot.sell_volume.is_finite()
                    && snapshot.sell_volume >= 0.0,
                "instrument {} trade volumes must be finite and non-negative",
                instrument.key
            );
        }
        if let Some(position) = &instrument.position {
            let position_epoch =
                validate_snapshot_timestamp(&position.as_of_timestamp, "position as_of_timestamp")?;
            ensure!(
                position_epoch <= next_quote_epoch.unwrap_or(last_epoch),
                "instrument {} position snapshot after the last finalized bar requires a later next_valid_quote_timestamp and must not exceed it",
                instrument.key
            );
            ensure!(
                position.quantity.is_finite() && position.quantity >= 0.0,
                "instrument {} position quantity must be finite and non-negative",
                instrument.key
            );
            ensure!(
                position
                    .average_price
                    .is_none_or(|value| value.is_finite() && value > 0.0),
                "instrument {} average position price must be finite and positive",
                instrument.key
            );
            ensure!(
                position.quantity > 0.0 || position.average_price.is_none(),
                "instrument {} flat position must not carry an average price",
                instrument.key
            );
        }
    }

    ensure!(
        (1..=MAX_OUTPUT_SERIES_TAIL_POINTS).contains(&request.output_projection.series_tail_points),
        "output_projection series_tail_points must be in 1..={MAX_OUTPUT_SERIES_TAIL_POINTS}"
    );
    ensure!(
        request.output_projection.signal_snapshots.len() <= request.instruments.len(),
        "output_projection signal_snapshots cannot exceed the instrument count"
    );
    let mut selected_keys = BTreeSet::new();
    let mut selected_timestamp_count = 0_usize;
    for selection in &request.output_projection.signal_snapshots {
        ensure!(
            selected_keys.insert(selection.instrument_key.as_str()),
            "output_projection signal snapshot instrument keys must be unique"
        );
        let instrument = request
            .instruments
            .iter()
            .find(|instrument| instrument.key == selection.instrument_key)
            .with_context(|| {
                format!(
                    "output_projection signal snapshots reference unknown instrument {}",
                    selection.instrument_key
                )
            })?;
        ensure!(
            !selection.timestamps.is_empty(),
            "output_projection signal snapshot timestamps must not be empty"
        );
        ensure!(
            selection.timestamps.len()
                == selection.timestamps.iter().collect::<BTreeSet<_>>().len(),
            "output_projection signal snapshot timestamps must be unique"
        );
        let bar_timestamps = instrument
            .bars
            .iter()
            .map(|bar| bar.timestamp.as_str())
            .collect::<BTreeSet<_>>();
        ensure!(
            selection
                .timestamps
                .iter()
                .all(|timestamp| bar_timestamps.contains(timestamp.as_str())),
            "output_projection signal snapshot timestamps must reference supplied finalized bars"
        );
        selected_timestamp_count = selected_timestamp_count
            .checked_add(selection.timestamps.len())
            .context("output_projection signal snapshot count overflow")?;
    }
    ensure!(
        selected_timestamp_count <= MAX_SIGNAL_SNAPSHOT_POINTS,
        "output_projection signal snapshots exceed {MAX_SIGNAL_SNAPSHOT_POINTS} points"
    );
    ensure!(
        selected_timestamp_count == 0
            || request.signal.as_ref().is_some_and(|signal| signal.enabled),
        "output_projection signal snapshots require enabled signal calculation"
    );

    let mut ids = BTreeSet::new();
    for definition in &request.indicators {
        ensure!(
            ids.insert(definition.id.clone()),
            "scalping indicator ids must be unique"
        );
    }
    if let Some(profile) = &request.volume_profile {
        ensure!(
            (1..=MAX_PROFILE_INSTRUMENTS).contains(&profile.instrument_keys.len()),
            "volume_profile instrument_keys must contain 1..={MAX_PROFILE_INSTRUMENTS} items"
        );
        ensure!(
            (5..=200).contains(&profile.bucket_count),
            "volume_profile bucket_count must be in 5..=200"
        );
        ensure!(
            profile.value_area_percent.is_finite()
                && (50.0..=99.0).contains(&profile.value_area_percent),
            "volume_profile value_area_percent must be in 50..=99"
        );
        ensure!(
            matches!(profile.price_source.as_str(), "close" | "typical_price"),
            "volume_profile price_source must be close or typical_price"
        );
        let original_count = profile.instrument_keys.len();
        let unique = profile.instrument_keys.iter().collect::<BTreeSet<_>>();
        ensure!(
            unique.len() == original_count,
            "volume_profile instrument_keys must be unique"
        );
        for key in &profile.instrument_keys {
            ensure!(
                keys.contains(key),
                "volume_profile references unknown instrument {key}"
            );
            let bar_count = request
                .instruments
                .iter()
                .find(|instrument| &instrument.key == key)
                .map(|instrument| instrument.bars.len())
                .unwrap_or_default();
            ensure!(
                bar_count <= MAX_PROFILE_OBSERVATIONS,
                "volume_profile instrument {key} exceeds {MAX_PROFILE_OBSERVATIONS} observations"
            );
        }
    }
    if let Some(signal) = &request.signal {
        ensure!(
            signal.entry_buffer_bps.is_finite()
                && (0.0..=1_000.0).contains(&signal.entry_buffer_bps),
            "signal entry_buffer_bps must be in 0..=1000"
        );
        ensure!(
            signal.stop_loss_bps.is_finite() && (1.0..=5_000.0).contains(&signal.stop_loss_bps),
            "signal stop_loss_bps must be in 1..=5000"
        );
        ensure!(
            signal.target_reward_ratio.is_finite()
                && (0.1..=20.0).contains(&signal.target_reward_ratio),
            "signal target_reward_ratio must be in 0.1..=20"
        );
    }
    let indicator_calculation_count = request
        .indicators
        .iter()
        .try_fold(0_usize, |count, definition| {
            count.checked_add(
                definition
                    .instrument_keys
                    .as_ref()
                    .map(Vec::len)
                    .unwrap_or(request.instruments.len()),
            )
        })
        .context("output projection indicator calculation count overflow")?;
    let instrument_count = request.instruments.len();
    let series_per_instrument = 8_usize
        .checked_add(
            if request.signal.as_ref().is_some_and(|signal| signal.enabled) {
                5
            } else {
                0
            },
        )
        .context("output projection series count overflow")?;
    let point_multiplier = if request.response_mode == ResponseMode::FullSeries {
        request.output_projection.series_tail_points
    } else {
        1
    };
    let series_units = indicator_calculation_count
        .checked_add(
            instrument_count
                .checked_mul(series_per_instrument)
                .context("output projection series count overflow")?,
        )
        .and_then(|count| count.checked_mul(point_multiplier))
        .context("output projection series units overflow")?;
    let snapshot_units = selected_timestamp_count
        .checked_mul(2)
        .context("output projection signal snapshot units overflow")?;
    let profile_units = request
        .volume_profile
        .as_ref()
        .and_then(|profile| {
            profile
                .instrument_keys
                .len()
                .checked_mul(profile.bucket_count)
        })
        .unwrap_or_default();
    let output_units = series_units
        .checked_add(snapshot_units)
        .and_then(|units| units.checked_add(profile_units))
        .context("output projection serialization units overflow")?;
    ensure!(
        output_units <= MAX_OUTPUT_SERIALIZATION_UNITS,
        "output_projection exceeds the bounded serialization budget of {MAX_OUTPUT_SERIALIZATION_UNITS} units"
    );
    Ok(())
}

fn translated_request(request: &ScalpingAnalysisRequest) -> Result<TranslatedRequest> {
    let mut epochs = request
        .instruments
        .iter()
        .flat_map(|instrument| instrument.bars.iter())
        .map(|bar| parse_timestamp(&bar.timestamp).map(|parsed| parsed.epoch_millis))
        .collect::<Result<Vec<_>>>()?;
    epochs.sort_unstable();
    epochs.dedup();
    let base = epoch_day("2000-01-01")?;
    let mut date_by_epoch = BTreeMap::new();
    let mut global_timestamp_by_date = BTreeMap::new();
    for (index, epoch) in epochs.iter().enumerate() {
        let date = civil_from_days(base + index as i64);
        date_by_epoch.insert(*epoch, date.clone());
        global_timestamp_by_date.insert(date, format_utc_timestamp(*epoch));
    }
    let mut local_timestamp_by_date = BTreeMap::new();
    let mut instruments = Vec::with_capacity(request.instruments.len());
    for instrument in &request.instruments {
        let mut local = BTreeMap::new();
        let mut bars = Vec::with_capacity(instrument.bars.len());
        for bar in &instrument.bars {
            let epoch = parse_timestamp(&bar.timestamp)?.epoch_millis;
            let date = date_by_epoch
                .get(&epoch)
                .context("synthetic timestamp mapping is missing")?
                .clone();
            local.insert(date.clone(), bar.timestamp.clone());
            bars.push(OhlcvBar {
                date,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
            });
        }
        local_timestamp_by_date.insert(instrument.key.clone(), local);
        instruments.push(InstrumentSeries {
            key: instrument.key.clone(),
            symbol: instrument.symbol.clone(),
            market: instrument.market.clone(),
            currency: instrument.currency.clone(),
            instrument_type: instrument.instrument_type,
            bars,
        });
    }
    let mut indicators = request.indicators.clone();
    for definition in &mut indicators {
        if definition.kind != IndicatorKind::VwapAnchoredVwap {
            continue;
        }
        let Some(anchor) = definition
            .parameters
            .get("anchor_date")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let epoch = if anchor.contains('T') {
            parse_timestamp(anchor)
                .with_context(|| {
                    format!("indicator {} anchor_date must be RFC3339", definition.id)
                })?
                .epoch_millis
        } else {
            parse_iso_date(anchor).with_context(|| {
                format!(
                    "indicator {} anchor_date must be an ISO session date or RFC3339 timestamp",
                    definition.id
                )
            })?;
            request
                .instruments
                .iter()
                .flat_map(|instrument| instrument.bars.iter())
                .filter(|bar| bar.session_date.as_str() >= anchor)
                .map(|bar| parse_timestamp(&bar.timestamp).map(|parsed| parsed.epoch_millis))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .min()
                .unwrap_or(i64::MAX)
        };
        let synthetic = date_by_epoch
            .range(epoch..)
            .next()
            .map(|(_, date)| date.clone())
            .unwrap_or_else(|| civil_from_days(base + epochs.len() as i64));
        global_timestamp_by_date
            .entry(synthetic.clone())
            .or_insert_with(|| anchor.to_owned());
        definition
            .parameters
            .insert("anchor_date".into(), json!(synthetic));
    }
    let technical = (!indicators.is_empty()).then_some(TechnicalAnalysisRequest {
        schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
        response_mode: request.response_mode,
        adjustment_policy: request.adjustment_policy,
        instruments: instruments.clone(),
        indicators,
    });
    Ok(TranslatedRequest {
        technical_request: technical,
        local_timestamps: local_timestamp_by_date,
        global_timestamps: global_timestamp_by_date,
        instruments,
    })
}

fn mapped_timestamp(
    date: &str,
    local: &BTreeMap<String, String>,
    global: &BTreeMap<String, String>,
) -> String {
    local
        .get(date)
        .or_else(|| global.get(date))
        .cloned()
        .unwrap_or_else(|| date.to_owned())
}

fn map_parameter_timestamps(
    mut parameters: BTreeMap<String, Value>,
    local: &BTreeMap<String, String>,
    global: &BTreeMap<String, String>,
) -> BTreeMap<String, Value> {
    if let Some(date) = parameters.get("anchor_date").and_then(Value::as_str)
        && (local.contains_key(date) || global.contains_key(date))
    {
        parameters.insert(
            "anchor_date".into(),
            json!(mapped_timestamp(date, local, global)),
        );
    }
    parameters
}

fn map_metadata_timestamps(
    mut metadata: BTreeMap<String, Value>,
    local: &BTreeMap<String, String>,
    global: &BTreeMap<String, String>,
) -> BTreeMap<String, Value> {
    for key in ["requested_anchor_date", "resolved_anchor_date"] {
        let Some(date) = metadata.get(key).and_then(Value::as_str) else {
            continue;
        };
        if local.contains_key(date) || global.contains_key(date) {
            metadata.insert(
                key.replace("_date", "_timestamp"),
                json!(mapped_timestamp(date, local, global)),
            );
            metadata.remove(key);
        }
    }
    metadata.insert("time_axis".into(), json!("rfc3339_timestamp"));
    metadata
}

fn map_point(
    point: crate::indicators::IndicatorPoint,
    local: &BTreeMap<String, String>,
    global: &BTreeMap<String, String>,
) -> ScalpingIndicatorPoint {
    ScalpingIndicatorPoint {
        timestamp: mapped_timestamp(&point.date, local, global),
        state: point.state,
        values: point.values,
    }
}

fn retain_tail<T>(points: &mut Vec<T>, limit: usize) {
    if points.len() > limit {
        points.drain(..points.len() - limit);
    }
}

fn map_profile(
    profile: crate::indicators::VolumeProfileResult,
    local: &BTreeMap<String, String>,
    global: &BTreeMap<String, String>,
) -> ScalpingVolumeProfile {
    ScalpingVolumeProfile {
        schema_version: profile.schema_version,
        from_timestamp: mapped_timestamp(&profile.from_date, local, global),
        to_timestamp: mapped_timestamp(&profile.to_date, local, global),
        price_source: profile.price_source,
        requested_bucket_count: profile.requested_bucket_count,
        effective_bucket_count: profile.effective_bucket_count,
        price_min: profile.price_min,
        price_max: profile.price_max,
        bucket_width: profile.bucket_width,
        total_volume: profile.total_volume,
        included_observations: profile.included_observations,
        missing_volume_observations: profile.missing_volume_observations,
        value_area_percent: profile.value_area_percent,
        point_of_control: profile.point_of_control,
        value_area_high: profile.value_area_high,
        value_area_low: profile.value_area_low,
        buckets: profile.buckets,
        approximation: profile.approximation,
    }
}

fn map_calculation(
    calculation: IndicatorCalculation,
    local: &BTreeMap<String, String>,
    global: &BTreeMap<String, String>,
    series_tail_points: usize,
) -> ScalpingIndicatorCalculation {
    let first_available_timestamp = calculation
        .warmup
        .first_available_date
        .as_deref()
        .map(|date| mapped_timestamp(date, local, global));
    let mut mapped = ScalpingIndicatorCalculation {
        instrument_key: calculation.instrument_key,
        indicator_id: calculation.indicator_id,
        kind: calculation.kind,
        parameters: map_parameter_timestamps(calculation.parameters, local, global),
        availability: calculation.availability,
        warmup: ScalpingWarmupMetadata {
            required_observations: calculation.warmup.required_observations,
            observed_observations: calculation.warmup.observed_observations,
            state: calculation.warmup.state,
            first_available_timestamp,
        },
        metadata: map_metadata_timestamps(calculation.metadata, local, global),
        profile: calculation
            .profile
            .map(|profile| map_profile(profile, local, global)),
        points: calculation.points.map(|points| {
            points
                .into_iter()
                .map(|point| map_point(point, local, global))
                .collect()
        }),
        latest: calculation
            .latest
            .map(|point| map_point(point, local, global)),
    };
    if let Some(points) = &mut mapped.points {
        retain_tail(points, series_tail_points);
    }
    mapped
}

fn availability_from_points(
    points: &[IntradayMetricPoint],
    unavailable_reason: &str,
) -> Availability {
    let available = points
        .iter()
        .filter(|point| point.state == PointState::Available)
        .count();
    let unavailable = points
        .iter()
        .filter(|point| point.state == PointState::Unavailable)
        .count();
    if available == 0 {
        Availability {
            status: AvailabilityStatus::InsufficientHistory,
            reason: unavailable_reason.into(),
        }
    } else if unavailable > 0 {
        Availability {
            status: AvailabilityStatus::Partial,
            reason: "partial_calculation_coverage".into(),
        }
    } else {
        Availability {
            status: AvailabilityStatus::Available,
            reason: "calculated".into(),
        }
    }
}

fn metric_series(
    mut points: Vec<IntradayMetricPoint>,
    response_mode: ResponseMode,
    availability: Availability,
    metadata: BTreeMap<String, Value>,
    series_tail_points: usize,
) -> IntradayMetricSeries {
    match response_mode {
        ResponseMode::FullSeries => {
            retain_tail(&mut points, series_tail_points);
            IntradayMetricSeries {
                availability,
                metadata,
                points: Some(points),
                latest: None,
            }
        }
        ResponseMode::LatestSummary => IntradayMetricSeries {
            availability,
            metadata,
            latest: points.last().cloned(),
            points: None,
        },
    }
}

fn values(entries: &[(&str, Option<f64>)]) -> BTreeMap<String, Option<f64>> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), *value))
        .collect()
}

fn session_vwap_points(
    instrument: &ScalpingInstrument,
    interval_minutes: u32,
) -> Result<Vec<IntradayMetricPoint>> {
    let confirmed = instrument
        .session_start_confirmed_dates
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut current_session = "";
    let mut coverage_confirmed = false;
    let mut weighted = 0.0;
    let mut volume_total = 0.0;
    let mut missing = false;
    let mut previous_bar: Option<&MinuteBar> = None;
    let mut points = Vec::with_capacity(instrument.bars.len());
    for bar in &instrument.bars {
        if current_session != bar.session_date {
            current_session = &bar.session_date;
            coverage_confirmed = confirmed.contains(bar.session_date.as_str());
            weighted = 0.0;
            volume_total = 0.0;
            missing = false;
            previous_bar = None;
        }
        if previous_bar.is_some_and(|previous| {
            unexpected_gap_in_validated_request(instrument, previous, bar, interval_minutes)
        }) {
            missing = true;
        }
        if let Some(volume) = bar.volume {
            weighted += (bar.high + bar.low + bar.close) / 3.0 * volume;
            volume_total += volume;
            ensure!(
                weighted.is_finite() && volume_total.is_finite(),
                "instrument {} session VWAP cumulative sum overflow at {}",
                instrument.key,
                bar.timestamp
            );
        } else {
            missing = true;
        }
        let value = (coverage_confirmed && !missing && volume_total > 0.0)
            .then(|| round(weighted / volume_total, 8));
        points.push(IntradayMetricPoint {
            timestamp: bar.timestamp.clone(),
            state: if value.is_some() {
                PointState::Available
            } else {
                PointState::Unavailable
            },
            values: values(&[("session_vwap", value)]),
        });
        previous_bar = Some(bar);
    }
    Ok(points)
}

fn anchored_vwap_points(
    instrument: &ScalpingInstrument,
    interval_minutes: u32,
) -> Result<Vec<IntradayMetricPoint>> {
    let anchor_epoch = instrument
        .anchored_vwap_timestamp
        .as_deref()
        .map(parse_timestamp)
        .transpose()?
        .map(|parsed| parsed.epoch_millis);
    let mut started = false;
    let mut weighted = 0.0;
    let mut volume_total = 0.0;
    let mut missing = false;
    let mut previous_started_bar: Option<&MinuteBar> = None;
    let mut points = Vec::with_capacity(instrument.bars.len());
    for bar in &instrument.bars {
        let epoch = parse_timestamp(&bar.timestamp)?.epoch_millis;
        if anchor_epoch.is_some_and(|anchor| epoch >= anchor) {
            started = true;
        }
        let mut value = None;
        let state = if !started {
            PointState::Warmup
        } else {
            if previous_started_bar.is_some_and(|previous| {
                unexpected_gap_in_validated_request(instrument, previous, bar, interval_minutes)
            }) {
                missing = true;
            }
            if let Some(volume) = bar.volume {
                weighted += (bar.high + bar.low + bar.close) / 3.0 * volume;
                volume_total += volume;
                ensure!(
                    weighted.is_finite() && volume_total.is_finite(),
                    "instrument {} anchored VWAP cumulative sum overflow at {}",
                    instrument.key,
                    bar.timestamp
                );
            } else {
                missing = true;
            }
            value = (!missing && volume_total > 0.0).then(|| round(weighted / volume_total, 8));
            if value.is_some() {
                PointState::Available
            } else {
                PointState::Unavailable
            }
        };
        points.push(IntradayMetricPoint {
            timestamp: bar.timestamp.clone(),
            state,
            values: values(&[("anchored_vwap", value)]),
        });
        if started {
            previous_started_bar = Some(bar);
        }
    }
    Ok(points)
}

fn opening_range_points(
    instrument: &ScalpingInstrument,
    interval_minutes: u32,
    range_minutes: u32,
) -> Vec<IntradayMetricPoint> {
    if interval_minutes > range_minutes {
        return instrument
            .bars
            .iter()
            .map(|bar| IntradayMetricPoint {
                timestamp: bar.timestamp.clone(),
                state: PointState::Unavailable,
                values: values(&[("high", None), ("low", None)]),
            })
            .collect();
    }
    let confirmed = instrument
        .session_start_confirmed_dates
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let required_bars = range_minutes.div_ceil(interval_minutes).max(1) as usize;
    let mut current_session = "";
    let mut coverage_confirmed = false;
    let mut count = 0_usize;
    let mut high = f64::NEG_INFINITY;
    let mut low = f64::INFINITY;
    let mut previous_bar: Option<&MinuteBar> = None;
    let mut range_invalid = false;
    let mut regular_window: Option<&SessionWindow> = None;
    let mut range_started = false;
    instrument
        .bars
        .iter()
        .map(|bar| {
            if current_session != bar.session_date {
                current_session = &bar.session_date;
                regular_window = session_windows_for_date(instrument, &bar.session_date)
                    .iter()
                    .find(|window| window.kind == "regular_market");
                coverage_confirmed =
                    regular_window.is_none() && confirmed.contains(bar.session_date.as_str());
                count = 0;
                high = f64::NEG_INFINITY;
                low = f64::INFINITY;
                previous_bar = None;
                range_invalid = false;
                range_started = regular_window.is_none();
            }
            let local_minute = parse_timestamp(&bar.timestamp)
                .expect("validated opening-range timestamp")
                .local_minute_of_day;
            if !range_started {
                let regular = regular_window.expect("checked configured regular window");
                if local_minute > regular.open_minute && local_minute <= regular.close_minute {
                    range_started = true;
                    coverage_confirmed = local_minute == regular.open_minute + interval_minutes;
                    range_invalid = !coverage_confirmed;
                } else {
                    return IntradayMetricPoint {
                        timestamp: bar.timestamp.clone(),
                        state: if local_minute > regular.close_minute {
                            PointState::Unavailable
                        } else {
                            PointState::Warmup
                        },
                        values: values(&[("high", None), ("low", None)]),
                    };
                }
            }
            if count < required_bars
                && previous_bar.is_some_and(|previous| {
                    unexpected_gap_in_validated_request(instrument, previous, bar, interval_minutes)
                })
            {
                range_invalid = true;
            }
            if count < required_bars {
                high = high.max(bar.high);
                low = low.min(bar.low);
            }
            count += 1;
            let ready = coverage_confirmed && !range_invalid && count >= required_bars;
            let point = IntradayMetricPoint {
                timestamp: bar.timestamp.clone(),
                state: if ready {
                    PointState::Available
                } else if !coverage_confirmed || range_invalid {
                    PointState::Unavailable
                } else {
                    PointState::Warmup
                },
                values: values(&[
                    ("high", ready.then_some(round(high, 8))),
                    ("low", ready.then_some(round(low, 8))),
                ]),
            };
            previous_bar = Some(bar);
            point
        })
        .collect()
}

fn time_of_day_relative_volume_points(
    instrument: &ScalpingInstrument,
    lookback_sessions: usize,
) -> Result<Vec<IntradayMetricPoint>> {
    let mut history: BTreeMap<u32, VecDeque<Option<f64>>> = BTreeMap::new();
    let mut current_session = "";
    let mut session_values: BTreeMap<u32, Option<f64>> = BTreeMap::new();
    let mut points = Vec::with_capacity(instrument.bars.len());
    for bar in &instrument.bars {
        if current_session != bar.session_date {
            for (slot, volume) in std::mem::take(&mut session_values) {
                let values = history.entry(slot).or_default();
                values.push_back(volume);
                while values.len() > lookback_sessions {
                    values.pop_front();
                }
            }
            current_session = &bar.session_date;
        }
        let parsed = parse_timestamp(&bar.timestamp)?;
        let prior = history.get(&parsed.local_minute_of_day);
        let enough_history = prior.is_some_and(|values| values.len() == lookback_sessions);
        let baseline = prior.filter(|_| enough_history).and_then(|values| {
            let complete = values.iter().copied().collect::<Option<Vec<_>>>()?;
            Some(complete.iter().sum::<f64>() / complete.len() as f64)
        });
        let relative = match (bar.volume, baseline) {
            (Some(0.0), Some(0.0)) => Some(0.0),
            (Some(current), Some(baseline)) if baseline > 0.0 => Some(round(current / baseline, 8)),
            _ => None,
        };
        let state = if !enough_history {
            PointState::Warmup
        } else if relative.is_some() {
            PointState::Available
        } else {
            PointState::Unavailable
        };
        points.push(IntradayMetricPoint {
            timestamp: bar.timestamp.clone(),
            state,
            values: values(&[("relative_volume", relative), ("baseline_volume", baseline)]),
        });
        session_values.insert(parsed.local_minute_of_day, bar.volume);
    }
    Ok(points)
}

fn session_level_points(
    instrument: &ScalpingInstrument,
    interval_minutes: u32,
) -> (Vec<IntradayMetricPoint>, Vec<IntradayMetricPoint>) {
    let start_confirmed = instrument
        .session_start_confirmed_dates
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let complete = instrument
        .complete_session_dates
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut previous_summary: Option<(f64, f64, f64)> = None;
    let mut current_session = "";
    let mut current_start_confirmed = false;
    let mut current_open = 0.0;
    let mut current_high = f64::NEG_INFINITY;
    let mut current_low = f64::INFINITY;
    let mut current_close = 0.0;
    let mut previous_bar: Option<&MinuteBar> = None;
    let mut current_gap = false;
    let mut previous_points = Vec::with_capacity(instrument.bars.len());
    let mut current_points = Vec::with_capacity(instrument.bars.len());
    for bar in &instrument.bars {
        if current_session != bar.session_date {
            if !current_session.is_empty() {
                previous_summary = complete.contains(current_session).then_some((
                    current_high,
                    current_low,
                    current_close,
                ));
            }
            current_session = &bar.session_date;
            current_start_confirmed = start_confirmed.contains(bar.session_date.as_str());
            current_open = bar.open;
            current_high = bar.high;
            current_low = bar.low;
            previous_bar = None;
            current_gap = false;
        } else {
            current_high = current_high.max(bar.high);
            current_low = current_low.min(bar.low);
        }
        if previous_bar.is_some_and(|previous| {
            unexpected_gap_in_validated_request(instrument, previous, bar, interval_minutes)
        }) {
            current_gap = true;
        }
        current_close = bar.close;
        let (previous_high, previous_low, previous_close) = previous_summary
            .map(|(high, low, close)| (Some(high), Some(low), Some(close)))
            .unwrap_or((None, None, None));
        previous_points.push(IntradayMetricPoint {
            timestamp: bar.timestamp.clone(),
            state: if previous_summary.is_some() {
                PointState::Available
            } else {
                PointState::Warmup
            },
            values: values(&[
                ("previous_high", previous_high.map(|value| round(value, 8))),
                ("previous_low", previous_low.map(|value| round(value, 8))),
                (
                    "previous_close",
                    previous_close.map(|value| round(value, 8)),
                ),
            ]),
        });
        current_points.push(IntradayMetricPoint {
            timestamp: bar.timestamp.clone(),
            state: if current_start_confirmed && !current_gap {
                PointState::Available
            } else {
                PointState::Unavailable
            },
            values: values(&[
                (
                    "session_open",
                    (current_start_confirmed && !current_gap).then_some(round(current_open, 8)),
                ),
                (
                    "session_high",
                    (current_start_confirmed && !current_gap).then_some(round(current_high, 8)),
                ),
                (
                    "session_low",
                    (current_start_confirmed && !current_gap).then_some(round(current_low, 8)),
                ),
            ]),
        });
        previous_bar = Some(bar);
    }
    (previous_points, current_points)
}

fn snapshot_metrics(instrument: &ScalpingInstrument) -> (SnapshotMetric, SnapshotMetric) {
    let last_bar_epoch =
        parse_timestamp(&instrument.bars.last().expect("validated bars").timestamp)
            .expect("validated timestamp")
            .epoch_millis;
    let orderbook = match &instrument.orderbook {
        Some(snapshot) => {
            let fresh = parse_timestamp(&snapshot.timestamp)
                .expect("validated orderbook timestamp")
                .epoch_millis
                >= last_bar_epoch;
            let denominator = snapshot.bid_volume + snapshot.ask_volume;
            let imbalance = (fresh && denominator > 0.0)
                .then(|| round((snapshot.bid_volume - snapshot.ask_volume) / denominator, 8));
            SnapshotMetric {
                availability: Availability {
                    status: if imbalance.is_some() {
                        AvailabilityStatus::Available
                    } else {
                        AvailabilityStatus::Unavailable
                    },
                    reason: if !fresh {
                        "snapshot_precedes_last_finalized_bar".into()
                    } else if imbalance.is_some() {
                        "calculated_from_current_snapshot".into()
                    } else {
                        "zero_total_visible_depth".into()
                    },
                },
                timestamp: Some(snapshot.timestamp.clone()),
                values: values(&[("orderbook_imbalance", imbalance)]),
                metadata: BTreeMap::from([
                    (
                        "formula".into(),
                        json!("(bid_volume-ask_volume)/(bid_volume+ask_volume)"),
                    ),
                    (
                        "scope".into(),
                        json!("caller_supplied_current_visible_depth_snapshot"),
                    ),
                    ("historical_orderbook_used".into(), json!(false)),
                ]),
            }
        }
        None => SnapshotMetric {
            availability: Availability {
                status: AvailabilityStatus::Unavailable,
                reason: "orderbook_snapshot_not_supplied".into(),
            },
            timestamp: None,
            values: values(&[("orderbook_imbalance", None)]),
            metadata: BTreeMap::from([("historical_orderbook_used".into(), json!(false))]),
        },
    };
    let execution = match &instrument.trade_stats {
        Some(snapshot) => {
            let fresh = parse_timestamp(&snapshot.timestamp)
                .expect("validated trade stats timestamp")
                .epoch_millis
                >= last_bar_epoch;
            let strength = (fresh && snapshot.sell_volume > 0.0)
                .then(|| round(snapshot.buy_volume / snapshot.sell_volume * 100.0, 8));
            SnapshotMetric {
                availability: Availability {
                    status: if strength.is_some() {
                        AvailabilityStatus::Available
                    } else {
                        AvailabilityStatus::Unavailable
                    },
                    reason: if !fresh {
                        "trade_window_precedes_last_finalized_bar".into()
                    } else if strength.is_some() {
                        "calculated_from_current_trade_window".into()
                    } else {
                        "zero_sell_volume_denominator".into()
                    },
                },
                timestamp: Some(snapshot.timestamp.clone()),
                values: values(&[("execution_strength_percent", strength)]),
                metadata: BTreeMap::from([
                    ("formula".into(), json!("buy_volume/sell_volume*100")),
                    ("scope".into(), json!("caller_supplied_trade_window")),
                    ("zero_denominator_policy".into(), json!("unavailable")),
                ]),
            }
        }
        None => SnapshotMetric {
            availability: Availability {
                status: AvailabilityStatus::Unavailable,
                reason: "trade_stats_not_supplied".into(),
            },
            timestamp: None,
            values: values(&[("execution_strength_percent", None)]),
            metadata: BTreeMap::new(),
        },
    };
    (orderbook, execution)
}

fn intraday_metrics(
    instrument: &ScalpingInstrument,
    request: &ScalpingAnalysisRequest,
) -> Result<IntradayMetrics> {
    let session_vwap = session_vwap_points(instrument, request.interval_minutes)?;
    let anchored_vwap = anchored_vwap_points(instrument, request.interval_minutes)?;
    let opening_5 = opening_range_points(instrument, request.interval_minutes, 5);
    let opening_15 = opening_range_points(instrument, request.interval_minutes, 15);
    let opening_30 = opening_range_points(instrument, request.interval_minutes, 30);
    let relative_volume =
        time_of_day_relative_volume_points(instrument, request.relative_volume_lookback_sessions)?;
    let (previous_levels, current_levels) =
        session_level_points(instrument, request.interval_minutes);
    let (orderbook, execution) = snapshot_metrics(instrument);
    let volume_missing = instrument.bars.iter().all(|bar| bar.volume.is_none());
    let any_session_start_confirmed = !instrument.session_start_confirmed_dates.is_empty();
    let any_complete_session = !instrument.complete_session_dates.is_empty();
    let volume_availability = |points: &[IntradayMetricPoint], reason: &str| {
        if volume_missing {
            Availability {
                status: AvailabilityStatus::VolumeUnavailable,
                reason: "all_bar_volume_values_are_missing".into(),
            }
        } else {
            availability_from_points(points, reason)
        }
    };
    let opening_series = |points: Vec<IntradayMetricPoint>, requested: u32| {
        let resolution_supported = request.interval_minutes <= requested;
        let availability = if !resolution_supported {
            Availability {
                status: AvailabilityStatus::Unavailable,
                reason: "selected_interval_coarser_than_opening_range".into(),
            }
        } else if any_session_start_confirmed {
            availability_from_points(&points, "opening_range_not_complete")
        } else {
            Availability {
                status: AvailabilityStatus::Unavailable,
                reason: "session_start_coverage_not_confirmed".into(),
            }
        };
        metric_series(
            points,
            request.response_mode,
            availability,
            BTreeMap::from([
                ("requested_minutes".into(), json!(requested)),
                (
                    "effective_minutes".into(),
                    json!(resolution_supported.then_some(
                        requested.div_ceil(request.interval_minutes) * request.interval_minutes,
                    )),
                ),
                (
                    "source_interval_minutes".into(),
                    json!(request.interval_minutes),
                ),
                ("completed_bar_only".into(), json!(true)),
                (
                    "anchor".into(),
                    json!(if !has_configured_session_windows(instrument) {
                        "first_confirmed_session_bar"
                    } else {
                        "caller_configured_regular_market_open"
                    }),
                ),
            ]),
            request.output_projection.series_tail_points,
        )
    };
    Ok(IntradayMetrics {
        session_vwap: metric_series(
            session_vwap.clone(),
            request.response_mode,
            if !any_session_start_confirmed {
                Availability {
                    status: AvailabilityStatus::Unavailable,
                    reason: "session_start_coverage_not_confirmed".into(),
                }
            } else {
                volume_availability(
                    &session_vwap,
                    "positive_complete_session_volume_not_available",
                )
            },
            BTreeMap::from([
                ("approximate".into(), json!(true)),
                ("price_basis".into(), json!("typical_price_hlc3")),
                ("weight".into(), json!("caller_supplied_final_bar_volume")),
                ("reset".into(), json!("session_date")),
                (
                    "accumulation_scope".into(),
                    json!(if !has_configured_session_windows(instrument) {
                        "all_supplied_session_bars"
                    } else {
                        "all_caller_configured_session_windows"
                    }),
                ),
                ("amount_used".into(), json!(false)),
                (
                    "approximation".into(),
                    json!("bar_hlc3_times_bar_volume_not_intrabar_execution_vwap"),
                ),
                (
                    "missing_volume_policy".into(),
                    json!("session_range_with_any_missing_volume_is_unavailable"),
                ),
                (
                    "caller_configured_session_windows".into(),
                    json!(instrument.session_windows),
                ),
                (
                    "caller_configured_session_window_overrides".into(),
                    json!(instrument.session_window_overrides),
                ),
                (
                    "scheduled_break_policy".into(),
                    json!("gaps_between_adjacent_caller_configured_windows_are_not_missing_bars"),
                ),
            ]),
            request.output_projection.series_tail_points,
        ),
        anchored_vwap: metric_series(
            anchored_vwap.clone(),
            request.response_mode,
            if instrument.anchored_vwap_timestamp.is_none() {
                Availability {
                    status: AvailabilityStatus::Unavailable,
                    reason: "anchor_timestamp_not_supplied".into(),
                }
            } else {
                volume_availability(&anchored_vwap, "anchor_after_last_finalized_bar")
            },
            BTreeMap::from([
                ("approximate".into(), json!(true)),
                ("price_basis".into(), json!("typical_price_hlc3")),
                (
                    "requested_anchor_timestamp".into(),
                    json!(instrument.anchored_vwap_timestamp),
                ),
                (
                    "anchor_resolution".into(),
                    json!("first_finalized_bar_on_or_after_timestamp"),
                ),
                ("future_data_used".into(), json!(false)),
            ]),
            request.output_projection.series_tail_points,
        ),
        opening_range_5: opening_series(opening_5, 5),
        opening_range_15: opening_series(opening_15, 15),
        opening_range_30: opening_series(opening_30, 30),
        time_of_day_relative_volume: metric_series(
            relative_volume.clone(),
            request.response_mode,
            volume_availability(
                &relative_volume,
                "required_prior_same_minute_sessions_not_available",
            ),
            BTreeMap::from([
                (
                    "lookback_sessions".into(),
                    json!(request.relative_volume_lookback_sessions),
                ),
                (
                    "baseline".into(),
                    json!("same_local_minute_across_completed_prior_sessions"),
                ),
                ("current_session_excluded".into(), json!(true)),
                (
                    "missing_volume_policy".into(),
                    json!("complete_lookback_required"),
                ),
            ]),
            request.output_projection.series_tail_points,
        ),
        previous_session_levels: metric_series(
            previous_levels.clone(),
            request.response_mode,
            if any_complete_session {
                availability_from_points(&previous_levels, "previous_session_not_available")
            } else {
                Availability {
                    status: AvailabilityStatus::Unavailable,
                    reason: "complete_prior_session_coverage_not_confirmed".into(),
                }
            },
            BTreeMap::from([("source".into(), json!("finalized_previous_session_bars"))]),
            request.output_projection.series_tail_points,
        ),
        current_session_levels: metric_series(
            current_levels.clone(),
            request.response_mode,
            if any_session_start_confirmed {
                availability_from_points(&current_levels, "session_bars_not_available")
            } else {
                Availability {
                    status: AvailabilityStatus::Unavailable,
                    reason: "session_start_coverage_not_confirmed".into(),
                }
            },
            BTreeMap::from([
                (
                    "source".into(),
                    json!("causal_finalized_current_session_prefix"),
                ),
                ("future_data_used".into(), json!(false)),
            ]),
            request.output_projection.series_tail_points,
        ),
        orderbook_imbalance: orderbook,
        execution_strength: execution,
    })
}

fn requested_volume_profiles(
    request: &ScalpingAnalysisRequest,
    technical_instruments: &[InstrumentSeries],
    local_timestamps: &BTreeMap<String, BTreeMap<String, String>>,
    global_timestamps: &BTreeMap<String, String>,
    control: Option<&dyn ComputeControl>,
) -> Result<BTreeMap<String, ScalpingVolumeProfileOutput>> {
    let Some(config) = &request.volume_profile else {
        return Ok(BTreeMap::new());
    };
    let mut results = BTreeMap::new();
    for key in &config.instrument_keys {
        checkpoint(control)?;
        let instrument = technical_instruments
            .iter()
            .find(|instrument| &instrument.key == key)
            .context("validated volume profile instrument is missing")?
            .clone();
        let profile_request = TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: request.response_mode,
            adjustment_policy: request.adjustment_policy,
            instruments: vec![instrument],
            indicators: vec![IndicatorDefinition {
                id: "__scalping_volume_profile".into(),
                kind: IndicatorKind::VolumeProfile,
                parameters: BTreeMap::from([
                    ("bucket_count".into(), json!(config.bucket_count)),
                    (
                        "value_area_percent".into(),
                        json!(config.value_area_percent),
                    ),
                    ("price_source".into(), json!(config.price_source)),
                ]),
                instrument_keys: Some(vec![key.clone()]),
            }],
        };
        let analyzed = analyze(&profile_request, control)?;
        let calculation = analyzed
            .calculations
            .into_iter()
            .next()
            .context("volume profile engine returned no calculation")?;
        let local = local_timestamps
            .get(key)
            .context("volume profile timestamp mapping is missing")?;
        results.insert(
            key.clone(),
            ScalpingVolumeProfileOutput {
                availability: calculation.availability,
                metadata: map_metadata_timestamps(calculation.metadata, local, global_timestamps),
                profile: calculation
                    .profile
                    .map(|profile| map_profile(profile, local, global_timestamps)),
            },
        );
    }
    Ok(results)
}

fn internal_scanner_calculations(
    request: &ScalpingAnalysisRequest,
    technical_instruments: &[InstrumentSeries],
    control: Option<&dyn ComputeControl>,
) -> Result<BTreeMap<(String, String), IndicatorCalculation>> {
    let definitions = vec![
        IndicatorDefinition {
            id: "__scanner_realized_volatility".into(),
            kind: IndicatorKind::HistoricalVolatility,
            parameters: BTreeMap::from([
                ("annualization".into(), json!(1)),
                ("period".into(), json!(20)),
                ("return_type".into(), json!("log")),
            ]),
            instrument_keys: None,
        },
        IndicatorDefinition {
            id: "__scanner_normalized_atr".into(),
            kind: IndicatorKind::NormalizedAtr,
            parameters: BTreeMap::from([("period".into(), json!(14))]),
            instrument_keys: None,
        },
        IndicatorDefinition {
            id: "__scanner_bollinger_width".into(),
            kind: IndicatorKind::BollingerBandWidthPercentB,
            parameters: BTreeMap::from([
                ("period".into(), json!(20)),
                ("source".into(), json!("close")),
                ("stddev_multiplier".into(), json!(2.0)),
            ]),
            instrument_keys: None,
        },
    ];
    let analysis = analyze(
        &TechnicalAnalysisRequest {
            schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
            response_mode: ResponseMode::FullSeries,
            adjustment_policy: request.adjustment_policy,
            instruments: technical_instruments.to_vec(),
            indicators: definitions,
        },
        control,
    )?;
    Ok(analysis
        .calculations
        .into_iter()
        .map(|calculation| {
            (
                (
                    calculation.instrument_key.clone(),
                    calculation.indicator_id.clone(),
                ),
                calculation,
            )
        })
        .collect())
}

fn scanner_metric_from_calculation(
    calculation: Option<&IndicatorCalculation>,
    field: &str,
    metadata: BTreeMap<String, Value>,
) -> ScannerMetric {
    let value = calculation
        .and_then(|calculation| calculation.points.as_ref())
        .and_then(|points| points.last())
        .filter(|point| point.state == PointState::Available)
        .and_then(|point| point.values.get(field).copied().flatten());
    ScannerMetric {
        availability: calculation
            .map(|calculation| calculation.availability.clone())
            .unwrap_or_else(|| Availability {
                status: AvailabilityStatus::Unavailable,
                reason: "internal_indicator_calculation_missing".into(),
            }),
        value,
        metadata,
    }
}

fn scanner_metrics(
    instrument: &ScalpingInstrument,
    intraday: &IntradayMetrics,
    calculations: &BTreeMap<(String, String), IndicatorCalculation>,
    interval_minutes: u32,
) -> ScannerMetrics {
    let key = &instrument.key;
    let realized = scanner_metric_from_calculation(
        calculations.get(&(key.clone(), "__scanner_realized_volatility".into())),
        "value",
        BTreeMap::from([
            ("engine".into(), json!(INDICATOR_ENGINE_VERSION)),
            ("period".into(), json!(20)),
            ("return_type".into(), json!("log")),
            ("annualization".into(), json!(1)),
            (
                "unit".into(),
                json!("percent_unannualized_population_standard_deviation"),
            ),
        ]),
    );
    let natr = scanner_metric_from_calculation(
        calculations.get(&(key.clone(), "__scanner_normalized_atr".into())),
        "value",
        BTreeMap::from([
            ("engine".into(), json!(INDICATOR_ENGINE_VERSION)),
            ("period".into(), json!(14)),
            ("smoothing".into(), json!("shared_engine_wilder_smoothing")),
            ("unit".into(), json!("percent")),
        ]),
    );
    let width_calculation = calculations.get(&(key.clone(), "__scanner_bollinger_width".into()));
    let widths = width_calculation
        .and_then(|calculation| calculation.points.as_ref())
        .map(|points| {
            points
                .iter()
                .filter(|point| point.state == PointState::Available)
                .filter_map(|point| point.values.get("bandwidth").copied().flatten())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let width_expansion = if widths.len() >= 21 {
        let current = *widths.last().unwrap();
        let baseline = widths[widths.len() - 21..widths.len() - 1]
            .iter()
            .sum::<f64>()
            / 20.0;
        (baseline > 0.0).then(|| round(current / baseline - 1.0, 8))
    } else {
        None
    };
    let width_metric = ScannerMetric {
        availability: if width_expansion.is_some() {
            Availability {
                status: AvailabilityStatus::Available,
                reason: "calculated".into(),
            }
        } else {
            Availability {
                status: AvailabilityStatus::InsufficientHistory,
                reason: "twenty_prior_bollinger_width_observations_not_available".into(),
            }
        },
        value: width_expansion,
        metadata: BTreeMap::from([
            ("engine".into(), json!(INDICATOR_ENGINE_VERSION)),
            ("bollinger_period".into(), json!(20)),
            ("baseline_period".into(), json!(20)),
            (
                "formula".into(),
                json!("current_bandwidth/mean(previous_20_bandwidths)-1"),
            ),
            (
                "current_observation_excluded_from_baseline".into(),
                json!(true),
            ),
        ]),
    };
    let latest_bar = instrument.bars.last().expect("validated bars");
    let session_bars = instrument
        .bars
        .iter()
        .rev()
        .take_while(|bar| bar.session_date == latest_bar.session_date)
        .collect::<Vec<_>>();
    let session_open = session_bars.last().map(|bar| bar.open).unwrap();
    let session_high = session_bars
        .iter()
        .map(|bar| bar.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let session_low = session_bars
        .iter()
        .map(|bar| bar.low)
        .fold(f64::INFINITY, f64::min);
    let session_has_gap = instrument.bars.windows(2).any(|bars| {
        bars[0].session_date == latest_bar.session_date
            && bars[1].session_date == latest_bar.session_date
            && unexpected_gap_in_validated_request(instrument, &bars[0], &bars[1], interval_minutes)
    });
    let session_start_confirmed = instrument
        .session_start_confirmed_dates
        .iter()
        .any(|date| date == &latest_bar.session_date)
        && !session_has_gap;
    let day_range =
        session_start_confirmed.then(|| round((session_high - session_low) / session_open, 8));
    let relative_volume = intraday
        .time_of_day_relative_volume
        .points
        .as_ref()
        .and_then(|points| points.last())
        .or(intraday.time_of_day_relative_volume.latest.as_ref());
    let relative_value = relative_volume
        .filter(|point| point.state == PointState::Available)
        .and_then(|point| point.values.get("relative_volume").copied().flatten());
    let amount_values = session_bars
        .iter()
        .map(|bar| bar.amount)
        .collect::<Option<Vec<_>>>();
    let trading_amount = session_start_confirmed
        .then_some(amount_values)
        .flatten()
        .as_ref()
        .map(|values| round(values.iter().sum(), 4));
    let last_bar_epoch = parse_timestamp(&latest_bar.timestamp)
        .expect("validated bar timestamp")
        .epoch_millis;
    let spread = instrument.orderbook.as_ref().and_then(|snapshot| {
        let snapshot_epoch = parse_timestamp(&snapshot.timestamp)
            .expect("validated orderbook timestamp")
            .epoch_millis;
        if snapshot_epoch < last_bar_epoch {
            return None;
        }
        let (bid, ask) = (snapshot.best_bid?, snapshot.best_ask?);
        let midpoint = (bid + ask) / 2.0;
        (midpoint > 0.0).then(|| round((ask - bid) / midpoint * 10_000.0, 8))
    });
    ScannerMetrics {
        realized_volatility: realized,
        normalized_atr: natr,
        day_range_ratio: ScannerMetric {
            availability: Availability {
                status: if day_range.is_some() {
                    AvailabilityStatus::Available
                } else {
                    AvailabilityStatus::Unavailable
                },
                reason: if day_range.is_some() {
                    "calculated".into()
                } else {
                    "session_start_coverage_not_confirmed".into()
                },
            },
            value: day_range,
            metadata: BTreeMap::from([
                (
                    "formula".into(),
                    json!("(current_session_high-current_session_low)/current_session_open"),
                ),
                ("unit".into(), json!("ratio")),
                ("finalized_bars_only".into(), json!(true)),
            ]),
        },
        bollinger_width_expansion: width_metric,
        relative_volume: ScannerMetric {
            availability: intraday.time_of_day_relative_volume.availability.clone(),
            value: relative_value,
            metadata: BTreeMap::from([
                ("baseline".into(), json!("same_local_minute_prior_sessions")),
                ("current_session_excluded".into(), json!(true)),
            ]),
        },
        trading_amount: ScannerMetric {
            availability: Availability {
                status: if trading_amount.is_some() {
                    AvailabilityStatus::Available
                } else if session_start_confirmed
                    && !session_bars.iter().all(|bar| bar.amount.is_none())
                {
                    AvailabilityStatus::Partial
                } else {
                    AvailabilityStatus::Unavailable
                },
                reason: if trading_amount.is_some() {
                    "calculated".into()
                } else if !session_start_confirmed {
                    "session_start_coverage_not_confirmed".into()
                } else if session_bars.iter().all(|bar| bar.amount.is_none()) {
                    "session_amount_unavailable".into()
                } else {
                    "partial_session_amount_coverage".into()
                },
            },
            value: trading_amount,
            metadata: BTreeMap::from([
                (
                    "formula".into(),
                    json!("sum(caller_supplied_final_bar_amount)"),
                ),
                (
                    "missing_policy".into(),
                    json!("complete_current_session_coverage_required"),
                ),
            ]),
        },
        spread_bps: ScannerMetric {
            availability: Availability {
                status: if spread.is_some() {
                    AvailabilityStatus::Available
                } else {
                    AvailabilityStatus::Unavailable
                },
                reason: if instrument.orderbook.as_ref().is_some_and(|snapshot| {
                    snapshot.best_bid.is_some()
                        && parse_timestamp(&snapshot.timestamp)
                            .expect("validated orderbook timestamp")
                            .epoch_millis
                            >= last_bar_epoch
                }) {
                    "calculated".into()
                } else if instrument.orderbook.as_ref().is_some_and(|snapshot| {
                    parse_timestamp(&snapshot.timestamp)
                        .expect("validated orderbook timestamp")
                        .epoch_millis
                        < last_bar_epoch
                }) {
                    "snapshot_precedes_last_finalized_bar".into()
                } else {
                    "best_bid_and_best_ask_not_supplied".into()
                },
            },
            value: spread,
            metadata: BTreeMap::from([
                (
                    "formula".into(),
                    json!("(best_ask-best_bid)/midpoint*10000"),
                ),
                ("unit".into(), json!("basis_points")),
                ("historical_orderbook_used".into(), json!(false)),
            ]),
        },
    }
}

fn multi_timeframe_trends(
    instrument: &ScalpingInstrument,
    base_interval: u32,
) -> Vec<BTreeMap<String, Option<TrendDirection>>> {
    let timeframes = [1_u32, 5, 15, 30, 60];
    let mut output = vec![BTreeMap::new(); instrument.bars.len()];
    for timeframe in timeframes {
        if timeframe < base_interval || timeframe % base_interval != 0 {
            for row in &mut output {
                row.insert(format!("{timeframe}m"), None);
            }
            continue;
        }
        let ratio = (timeframe / base_interval) as usize;
        let mut session = "";
        let mut session_window = None;
        let mut session_ordinal = 0_usize;
        let mut previous_completed_close: Option<f64> = None;
        let mut direction = None;
        for (index, bar) in instrument.bars.iter().enumerate() {
            if session != bar.session_date {
                session = &bar.session_date;
                session_window = None;
                session_ordinal = 0;
            }
            let parsed =
                parse_timestamp(&bar.timestamp).expect("validated multi-timeframe timestamp");
            let effective_minute = effective_session_minute(&parsed, &bar.session_date)
                .expect("validated multi-timeframe session minute");
            let current_window = session_window_index(
                session_windows_for_date(instrument, &bar.session_date),
                effective_minute,
                base_interval,
            );
            if current_window != session_window {
                session_window = current_window;
                session_ordinal = 0;
            }
            session_ordinal += 1;
            if session_ordinal.is_multiple_of(ratio) {
                direction = previous_completed_close.map(|previous| {
                    if bar.close > previous {
                        TrendDirection::Bullish
                    } else if bar.close < previous {
                        TrendDirection::Bearish
                    } else {
                        TrendDirection::Neutral
                    }
                });
                previous_completed_close = Some(bar.close);
            }
            output[index].insert(format!("{timeframe}m"), direction);
        }
    }
    output
}

fn timeframe_agreement(trends: &BTreeMap<String, Option<TrendDirection>>) -> String {
    let available = trends.values().copied().flatten().collect::<Vec<_>>();
    if available.len() < 2 {
        return "insufficient_timeframes".into();
    }
    if available
        .iter()
        .all(|direction| *direction == TrendDirection::Bullish)
    {
        "aligned_bullish".into()
    } else if available
        .iter()
        .all(|direction| *direction == TrendDirection::Bearish)
    {
        "aligned_bearish".into()
    } else {
        "mixed_or_neutral".into()
    }
}

fn indicator_ids_at(calculations: &[ScalpingIndicatorCalculation], timestamp: &str) -> Vec<String> {
    let mut ids = calculations
        .iter()
        .filter(|calculation| {
            calculation
                .points
                .as_ref()
                .and_then(|points| points.iter().find(|point| point.timestamp == timestamp))
                .or(calculation
                    .latest
                    .as_ref()
                    .filter(|point| point.timestamp == timestamp))
                .is_some_and(|point| point.state == PointState::Available)
        })
        .map(|calculation| calculation.indicator_id.clone())
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn assistance_signals(
    instrument: &ScalpingInstrument,
    request: &ScalpingAnalysisRequest,
    calculations: &[ScalpingIndicatorCalculation],
    selected_timestamps: &BTreeSet<String>,
) -> Result<(Option<AssistanceSignalSeries>, Vec<ScalpingSignalSnapshot>)> {
    let Some(config) = request.signal.as_ref().filter(|config| config.enabled) else {
        return Ok((None, Vec::new()));
    };
    let vwap = session_vwap_points(instrument, request.interval_minutes)?;
    let opening = opening_range_points(instrument, request.interval_minutes, 15);
    let trends = multi_timeframe_trends(instrument, request.interval_minutes);
    let position_epoch = instrument
        .position
        .as_ref()
        .map(|position| parse_timestamp(&position.as_of_timestamp))
        .transpose()?
        .map(|parsed| parsed.epoch_millis);
    let next_quote_epoch = instrument
        .next_valid_quote_timestamp
        .as_deref()
        .map(parse_timestamp)
        .transpose()?
        .map(|parsed| parsed.epoch_millis);
    let mut points = Vec::with_capacity(instrument.bars.len());
    let mut snapshots = Vec::with_capacity(selected_timestamps.len());
    let mut current_session = "";
    let mut previous_bar: Option<&MinuteBar> = None;
    let mut session_gap_seen = false;
    for (index, bar) in instrument.bars.iter().enumerate() {
        let bar_epoch = parse_timestamp(&bar.timestamp)?.epoch_millis;
        if current_session != bar.session_date {
            current_session = &bar.session_date;
            previous_bar = None;
            session_gap_seen = false;
        }
        if previous_bar.is_some_and(|previous| {
            unexpected_gap_in_validated_request(instrument, previous, bar, request.interval_minutes)
        }) {
            session_gap_seen = true;
        }
        let session_vwap = vwap[index].values.get("session_vwap").copied().flatten();
        let opening_high = opening[index].values.get("high").copied().flatten();
        let agreement = timeframe_agreement(&trends[index]);
        let position_known_at_calculation = position_epoch.is_some_and(|epoch| epoch <= bar_epoch);
        let post_close_position_for_latest_label = index + 1 == instrument.bars.len()
            && position_epoch.is_some_and(|epoch| {
                epoch > bar_epoch && next_quote_epoch.is_some_and(|quote| epoch <= quote)
            });
        let position_known = position_known_at_calculation || post_close_position_for_latest_label;
        let held = position_known
            && instrument
                .position
                .as_ref()
                .is_some_and(|position| position.quantity > 0.0);
        let bullish_alignment = agreement == "aligned_bullish";
        let bearish_alignment = agreement == "aligned_bearish";
        let (mut entry_condition, exit_condition, mut rationale) = match config.preset {
            SignalPreset::Trend => (
                session_vwap.is_some_and(|value| bar.close > value) && bullish_alignment,
                session_vwap.is_some_and(|value| bar.close < value) || bearish_alignment,
                vec![
                    "finalized_close_vs_session_vwap".into(),
                    "completed_multi_timeframe_close_direction".into(),
                ],
            ),
            SignalPreset::Breakout => (
                opening_high.is_some_and(|value| bar.close > value) && !bearish_alignment,
                session_vwap.is_some_and(|value| bar.close < value),
                vec![
                    "finalized_close_vs_opening_range_15_high".into(),
                    "finalized_close_vs_session_vwap".into(),
                ],
            ),
            SignalPreset::MeanReversion => (
                session_vwap.is_some_and(|value| bar.close < value * 0.995),
                session_vwap.is_some_and(|value| bar.close >= value),
                vec!["finalized_close_deviation_from_session_vwap".into()],
            ),
            SignalPreset::RiskManagement => {
                let position_stop = position_known_at_calculation
                    .then_some(instrument.position.as_ref())
                    .flatten()
                    .and_then(|position| {
                        position
                            .average_price
                            .map(|average| average * (1.0 - config.stop_loss_bps / 10_000.0))
                    });
                (
                    false,
                    position_stop.is_some_and(|stop| bar.close <= stop)
                        || session_vwap.is_some_and(|value| bar.close < value),
                    vec![
                        "position_average_price_stop_candidate".into(),
                        "finalized_close_vs_session_vwap".into(),
                    ],
                )
            }
        };
        if session_gap_seen {
            entry_condition = false;
            rationale.push("unrecovered_same_session_bar_gap".into());
        }
        if has_scheduled_window_tail(instrument, request.interval_minutes) {
            rationale.push("scheduled_window_tail_omitted".into());
        }
        if post_close_position_for_latest_label {
            rationale.push(
                "post_close_position_used_for_current_status_label_only_not_technical_conditions"
                    .into(),
            );
        } else if !position_known {
            rationale
                .push("position_state_unavailable_entry_candidate_does_not_assume_a_fill".into());
        }
        let mut status = if held {
            if exit_condition {
                AssistanceStatus::ExitCandidate
            } else {
                AssistanceStatus::Hold
            }
        } else if entry_condition {
            AssistanceStatus::EntryCandidate
        } else {
            AssistanceStatus::Watch
        };
        let risk_basis = if held {
            instrument
                .position
                .as_ref()
                .and_then(|position| position.average_price)
                .unwrap_or(bar.close)
        } else {
            bar.close
        };
        let risk = risk_basis * config.stop_loss_bps / 10_000.0;
        let stop = round((risk_basis - risk).max(f64::MIN_POSITIVE), 8);
        let target = round(risk_basis + risk * config.target_reward_ratio, 8);
        let entry_buffer = bar.close * config.entry_buffer_bps / 10_000.0;
        let expected_entry_range =
            (!held && status != AssistanceStatus::ExitCandidate).then(|| PriceRange {
                low: round((bar.close - entry_buffer).max(f64::MIN_POSITIVE), 8),
                high: round(bar.close + entry_buffer, 8),
            });
        let eligible = if index + 1 == instrument.bars.len()
            && instrument.next_valid_quote_timestamp.is_some()
        {
            instrument.next_valid_quote_timestamp.clone()
        } else if !has_configured_session_windows(instrument) {
            Some(format_utc_timestamp(
                bar_epoch + i64::from(request.interval_minutes) * 60_000,
            ))
        } else {
            next_scheduled_close_epoch(instrument, bar, request.interval_minutes)?
                .map(format_utc_timestamp)
        };
        if let Some(eligible) = &eligible {
            ensure!(
                parse_timestamp(eligible)?.epoch_millis > bar_epoch,
                "assistance signal eligibility must be after its calculation bar"
            );
        } else {
            status = AssistanceStatus::Watch;
            rationale.push("next_valid_market_timestamp_unavailable".into());
        }
        let indicator_ids = indicator_ids_at(calculations, &bar.timestamp);
        let volume_quality = if bar.volume.is_some() && !session_gap_seen {
            Availability {
                status: AvailabilityStatus::Available,
                reason: "finalized_ohlcv_bar_available".into(),
            }
        } else {
            Availability {
                status: AvailabilityStatus::Partial,
                reason: if session_gap_seen {
                    "unrecovered_same_session_bar_gap".into()
                } else {
                    "bar_volume_missing".into()
                },
            }
        };
        let available_timeframes = trends[index]
            .values()
            .filter(|value| value.is_some())
            .count();
        let confidence = round(
            (0.35
                + if session_vwap.is_some() { 0.2 } else { 0.0 }
                + if opening_high.is_some() { 0.1 } else { 0.0 }
                + (available_timeframes.min(3) as f64 * 0.08)
                + if !indicator_ids.is_empty() { 0.08 } else { 0.0 })
            .min(1.0),
            4,
        );
        let signal = AssistanceSignal {
            instrument_key: instrument.key.clone(),
            status,
            calculation_timestamp: bar.timestamp.clone(),
            signal_timestamp: bar.timestamp.clone(),
            earliest_eligible_timestamp: eligible.clone(),
            eligibility_basis: if eligible.is_none() {
                "caller_configured_session_ended_next_valid_quote_unavailable".into()
            } else if index + 1 == instrument.bars.len()
                && instrument.next_valid_quote_timestamp.is_some()
            {
                if post_close_position_for_latest_label {
                    "caller_supplied_next_valid_quote_after_finalized_bar_with_post_close_position_used_for_label_only".into()
                } else {
                    "caller_supplied_next_valid_quote_after_finalized_bar".into()
                }
            } else {
                "next_interval_candidate_after_finalized_bar_not_an_assumed_fill".into()
            },
            basis_price: round(bar.close, 8),
            expected_entry_range,
            stop_candidate_price: Some(stop),
            target_price_range: Some(PriceRange {
                low: target,
                high: target,
            }),
            expected_reward_risk_ratio: Some(round(config.target_reward_ratio, 4)),
            indicators: indicator_ids,
            multi_timeframe_trends: trends[index].clone(),
            multi_timeframe_agreement: agreement,
            confidence,
            confidence_semantics:
                "deterministic_data_and_condition_completeness_score_not_success_probability".into(),
            data_quality: volume_quality,
            position_known,
            rationale,
            disclaimer: "decision_support_only_not_an_order_instruction_or_return_guarantee".into(),
        };
        if selected_timestamps.contains(&bar.timestamp) {
            snapshots.push(ScalpingSignalSnapshot {
                calculation_timestamp: signal.calculation_timestamp.clone(),
                technical_signal: match signal.status {
                    AssistanceStatus::EntryCandidate => 1,
                    AssistanceStatus::ExitCandidate => -1,
                    AssistanceStatus::Watch | AssistanceStatus::Hold => 0,
                },
                multi_timeframe_agreement: signal.multi_timeframe_agreement.clone(),
                basis_price: signal.basis_price,
                stop_candidate_price: signal.stop_candidate_price,
                target_candidate_price: signal
                    .target_price_range
                    .as_ref()
                    .map(|range| round((range.low + range.high) / 2.0, 8)),
            });
        }
        points.push(signal);
        previous_bar = Some(bar);
    }
    Ok((
        Some(match request.response_mode {
            ResponseMode::FullSeries => {
                retain_tail(&mut points, request.output_projection.series_tail_points);
                AssistanceSignalSeries {
                    points: Some(points),
                    latest: None,
                }
            }
            ResponseMode::LatestSummary => AssistanceSignalSeries {
                latest: points.last().cloned(),
                points: None,
            },
        }),
        snapshots,
    ))
}

fn data_quality(instrument: &ScalpingInstrument, interval_minutes: u32) -> ScalpingDataQuality {
    let missing_volume_count = instrument
        .bars
        .iter()
        .filter(|bar| bar.volume.is_none())
        .count();
    let missing_amount_count = instrument
        .bars
        .iter()
        .filter(|bar| bar.amount.is_none())
        .count();
    let same_session_gap_count = instrument
        .bars
        .windows(2)
        .filter(|bars| {
            unexpected_gap_in_validated_request(instrument, &bars[0], &bars[1], interval_minutes)
        })
        .count();
    let latest_session_start_confirmed = instrument.bars.last().is_some_and(|bar| {
        instrument
            .session_start_confirmed_dates
            .contains(&bar.session_date)
    });
    let scheduled_window_tail_omitted = has_scheduled_window_tail(instrument, interval_minutes);
    let status = if missing_volume_count == instrument.bars.len() {
        AvailabilityStatus::VolumeUnavailable
    } else if missing_volume_count > 0
        || missing_amount_count > 0
        || same_session_gap_count > 0
        || scheduled_window_tail_omitted
        || !latest_session_start_confirmed
    {
        AvailabilityStatus::Partial
    } else {
        AvailabilityStatus::Available
    };
    let mut reasons = Vec::new();
    if missing_volume_count > 0 {
        reasons.push("missing_bar_volume".into());
    }
    if missing_amount_count > 0 {
        reasons.push("missing_bar_amount".into());
    }
    if same_session_gap_count > 0 {
        reasons.push("same_session_bar_gaps".into());
    }
    if scheduled_window_tail_omitted {
        reasons.push("scheduled_window_tail_omitted".into());
    }
    if !latest_session_start_confirmed {
        reasons.push("latest_session_start_coverage_unconfirmed".into());
    }
    if instrument.orderbook.is_none() {
        reasons.push("current_orderbook_snapshot_not_supplied".into());
    }
    ScalpingDataQuality {
        status,
        final_bar_count: instrument.bars.len(),
        same_session_gap_count,
        missing_volume_count,
        missing_amount_count,
        orderbook_history: "unavailable_not_inferred_from_current_snapshot".into(),
        reasons,
    }
}

pub fn analyze_scalping(
    request: &ScalpingAnalysisRequest,
    control: Option<&dyn ComputeControl>,
) -> Result<ScalpingAnalysisResult> {
    checkpoint(control)?;
    validate_request(request)?;
    let translated = translated_request(request)?;
    let mut mapped_calculations: BTreeMap<String, Vec<ScalpingIndicatorCalculation>> = request
        .instruments
        .iter()
        .map(|instrument| (instrument.key.clone(), Vec::new()))
        .collect();
    if let Some(technical_request) = translated.technical_request {
        let technical = analyze(&technical_request, control)?;
        for calculation in technical.calculations {
            let key = calculation.instrument_key.clone();
            let local = translated
                .local_timestamps
                .get(&key)
                .context("technical timestamp mapping is missing")?;
            mapped_calculations
                .get_mut(&key)
                .context("technical calculation references an unknown instrument")?
                .push(map_calculation(
                    calculation,
                    local,
                    &translated.global_timestamps,
                    request.output_projection.series_tail_points,
                ));
        }
    }
    let scanner_calculations =
        internal_scanner_calculations(request, &translated.instruments, control)?;
    let mut profiles = requested_volume_profiles(
        request,
        &translated.instruments,
        &translated.local_timestamps,
        &translated.global_timestamps,
        control,
    )?;
    let mut instruments = request.instruments.iter().collect::<Vec<_>>();
    instruments.sort_by(|left, right| left.key.cmp(&right.key));
    let selected_signal_timestamps = request
        .output_projection
        .signal_snapshots
        .iter()
        .map(|selection| {
            (
                selection.instrument_key.as_str(),
                selection
                    .timestamps
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut results = Vec::with_capacity(instruments.len());
    for instrument in instruments {
        checkpoint(control)?;
        let calculations = mapped_calculations
            .remove(&instrument.key)
            .context("scalping calculation collection is missing")?;
        let intraday = intraday_metrics(instrument, request)?;
        let scanner_metrics = scanner_metrics(
            instrument,
            &intraday,
            &scanner_calculations,
            request.interval_minutes,
        );
        let selected_timestamps = selected_signal_timestamps
            .get(instrument.key.as_str())
            .cloned()
            .unwrap_or_default();
        let (signals, signal_snapshots) =
            assistance_signals(instrument, request, &calculations, &selected_timestamps)?;
        results.push(ScalpingInstrumentResult {
            instrument_key: instrument.key.clone(),
            interval_minutes: request.interval_minutes,
            bar_count: instrument.bars.len(),
            indicators: calculations,
            intraday,
            volume_profile: profiles.remove(&instrument.key),
            signals,
            signal_snapshots,
            scanner_metrics,
            data_quality: data_quality(instrument, request.interval_minutes),
        });
    }
    let total_bar_count = request
        .instruments
        .iter()
        .map(|instrument| instrument.bars.len())
        .sum();
    checkpoint(control)?;
    Ok(ScalpingAnalysisResult {
        schema_version: SCALPING_RESULT_SCHEMA_VERSION.into(),
        scalping_engine_version: SCALPING_ENGINE_VERSION.into(),
        indicator_engine_version: INDICATOR_ENGINE_VERSION.into(),
        response_mode: request.response_mode,
        interval_minutes: request.interval_minutes,
        instruments: results,
        diagnostics: ScalpingDiagnostics {
            validation: "strict_complete_sorted_unique_rfc3339_minute_ohlcv_batch".into(),
            timestamp_policy: "RFC3339 instants are ordered in UTC; session_date is the explicit local exchange-session calendar date".into(),
            bar_policy: "forming bars are rejected; calculations consume finalized bars only".into(),
            indicator_reuse: format!("all selected indicators and scanner volatility primitives use shared Rust {INDICATOR_ENGINE_VERSION}"),
            session_vwap_policy: "session-date reset HLC3 times final-bar volume approximation; explicitly configured inter-window breaks are not treated as missing bars; amount is not substituted for missing volume".into(),
            relative_volume_policy: "current volume divided by complete same-local-minute observations from prior sessions only".into(),
            signal_execution_policy: "signals are decision support only and earliest eligibility is strictly after the finalized calculation bar; a position snapshot after that close but at-or-before an explicit next valid quote may affect only the current status label, never historical technical conditions; no fill or order is generated".into(),
            orderbook_history_policy: "only an explicitly supplied current snapshot is used; historical orderbook is unavailable and never synthesized".into(),
            output_projection_policy: "full-series indicator, intraday, and assistance-signal arrays are bounded to the requested tail; evaluation receives only explicitly selected compact signal snapshots".into(),
            series_tail_points: request.output_projection.series_tail_points,
            signal_snapshot_count: request
                .output_projection
                .signal_snapshots
                .iter()
                .map(|selection| selection.timestamps.len())
                .sum(),
            instrument_count: request.instruments.len(),
            indicator_definition_count: request.indicators.len(),
            total_bar_count,
            messages: vec![
                "scanner realized volatility, normalized ATR, and Bollinger bandwidth reuse the shared versioned indicator engine".into(),
                "opening ranges use finalized session bars only when the selected interval is no coarser than the requested range; coarser inputs are explicitly unavailable".into(),
                "higher-timeframe direction changes only when a full aggregate-sized group of finalized base bars exists; an in-progress higher-timeframe group is ignored".into(),
                "confidence is a deterministic data/condition completeness score, not a forecast probability or return guarantee".into(),
                "volume profile remains bounded to explicitly requested instruments, 200 buckets, and 20,000 finalized bars per instrument".into(),
                format!("serialized point series retain at most {} observations per instrument while all supplied bars remain calculation inputs", request.output_projection.series_tail_points),
                "scheduled session windows are validated, and only exact adjacent-window boundary transitions are exempted from same-session gap diagnostics".into(),
            ],
        },
    })
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::contracts::{JobKind, WorkerInput};
    use crate::{ENGINE_VERSION, WORKER_SCHEMA_VERSION};

    fn bars(symbol_offset: f64, sessions: usize, bars_per_session: usize) -> Vec<MinuteBar> {
        let start_day = epoch_day("2026-06-01").unwrap();
        let mut output = Vec::new();
        for session in 0..sessions {
            let date = civil_from_days(start_day + session as i64);
            for slot in 0..bars_per_session {
                let minute = 1 + slot;
                let base = 100.0 + symbol_offset + session as f64 * 1.5 + slot as f64 * 0.12;
                let close = base + if slot % 3 == 0 { 0.08 } else { -0.03 };
                let volume = 1_000.0 + session as f64 * 50.0 + slot as f64 * 10.0;
                output.push(MinuteBar {
                    timestamp: format!("{date}T09:{minute:02}:00+09:00"),
                    session_date: date.clone(),
                    open: base,
                    high: base.max(close) + 0.3,
                    low: base.min(close) - 0.25,
                    close,
                    volume: Some(volume),
                    amount: Some(volume * close),
                    complete: true,
                });
            }
        }
        output
    }

    fn instrument(key: &str, offset: f64) -> ScalpingInstrument {
        let bars = bars(offset, 6, 25);
        let session_dates = bars
            .iter()
            .map(|bar| bar.session_date.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        ScalpingInstrument {
            key: key.into(),
            symbol: key.rsplit(':').next().unwrap().into(),
            market: "KRX".into(),
            currency: "KRW".into(),
            instrument_type: InstrumentType::Stock,
            session_start_confirmed_dates: session_dates.clone(),
            complete_session_dates: session_dates,
            session_windows: Vec::new(),
            session_window_overrides: Vec::new(),
            anchored_vwap_timestamp: Some(bars[30].timestamp.clone()),
            next_valid_quote_timestamp: None,
            orderbook: Some(OrderBookSnapshot {
                timestamp: bars.last().unwrap().timestamp.clone(),
                bid_volume: 12_000.0,
                ask_volume: 10_000.0,
                best_bid: Some(bars.last().unwrap().close - 0.05),
                best_ask: Some(bars.last().unwrap().close + 0.05),
            }),
            trade_stats: Some(TradeStatsSnapshot {
                timestamp: bars.last().unwrap().timestamp.clone(),
                buy_volume: 14_000.0,
                sell_volume: 10_000.0,
            }),
            position: Some(PositionSnapshot {
                as_of_timestamp: bars[0].timestamp.clone(),
                quantity: 0.0,
                average_price: None,
            }),
            bars,
        }
    }

    fn request(mode: ResponseMode, include_second: bool) -> ScalpingAnalysisRequest {
        let first = instrument("KRW:005930", 0.0);
        let mut instruments = vec![first];
        if include_second {
            instruments.push(instrument("KRW:000660", 20.0));
        }
        ScalpingAnalysisRequest {
            schema_version: SCALPING_REQUEST_SCHEMA_VERSION.into(),
            response_mode: mode,
            adjustment_policy: AdjustmentPolicy::Adjusted,
            interval_minutes: 1,
            instruments,
            indicators: vec![
                IndicatorDefinition {
                    id: "sma-fast".into(),
                    kind: IndicatorKind::Sma,
                    parameters: BTreeMap::from([("period".into(), json!(5))]),
                    instrument_keys: None,
                },
                IndicatorDefinition {
                    id: "rsi".into(),
                    kind: IndicatorKind::Rsi,
                    parameters: BTreeMap::from([("period".into(), json!(14))]),
                    instrument_keys: None,
                },
            ],
            relative_volume_lookback_sessions: 5,
            volume_profile: Some(VolumeProfileConfig {
                instrument_keys: vec!["KRW:005930".into()],
                bucket_count: 24,
                value_area_percent: 70.0,
                price_source: "typical_price".into(),
            }),
            signal: Some(SignalConfig {
                enabled: true,
                preset: SignalPreset::Trend,
                entry_buffer_bps: 15.0,
                stop_loss_bps: 100.0,
                target_reward_ratio: 2.0,
            }),
            output_projection: ScalpingOutputProjection::default(),
        }
    }

    fn integrated_session_instrument() -> ScalpingInstrument {
        let date = "2026-07-21";
        let windows = vec![
            SessionWindow {
                kind: "pre_market".into(),
                open_minute: 480,
                close_minute: 530,
                local_date_offset: 0,
            },
            SessionWindow {
                kind: "regular_market".into(),
                open_minute: 540,
                close_minute: 930,
                local_date_offset: 0,
            },
            SessionWindow {
                kind: "after_market".into(),
                open_minute: 940,
                close_minute: 1_200,
                local_date_offset: 0,
            },
        ];
        let mut sequence = 0_usize;
        let mut bars = Vec::new();
        for window in &windows {
            for minute in (window.open_minute + 1)..=window.close_minute {
                let base = if window.kind == "after_market" {
                    80.0 - f64::from(minute - window.open_minute) / 100.0
                } else {
                    100.0 + sequence as f64 / 100.0
                };
                bars.push(MinuteBar {
                    timestamp: format!("{date}T{:02}:{:02}:00+09:00", minute / 60, minute % 60,),
                    session_date: date.into(),
                    open: base,
                    high: base + 0.2,
                    low: base - 0.2,
                    close: base + 0.05,
                    volume: Some(1_000.0 + sequence as f64),
                    amount: Some((1_000.0 + sequence as f64) * (base + 0.05)),
                    complete: true,
                });
                sequence += 1;
            }
        }
        let anchor = bars[0].timestamp.clone();
        ScalpingInstrument {
            key: "KRW:005930".into(),
            symbol: "005930".into(),
            market: "KRX_NXT_INTEGRATED".into(),
            currency: "KRW".into(),
            instrument_type: InstrumentType::Stock,
            session_start_confirmed_dates: vec![date.into()],
            complete_session_dates: vec![date.into()],
            session_windows: windows,
            session_window_overrides: Vec::new(),
            anchored_vwap_timestamp: Some(anchor.clone()),
            next_valid_quote_timestamp: None,
            orderbook: None,
            trade_stats: None,
            position: None,
            bars,
        }
    }

    fn metric_points(series: &IntradayMetricSeries) -> &[IntradayMetricPoint] {
        series.points.as_deref().unwrap()
    }

    #[test]
    fn timestamp_offsets_order_the_same_instant_once() {
        let seoul = parse_timestamp("2026-07-21T09:00:00+09:00").unwrap();
        let utc = parse_timestamp("2026-07-21T00:00:00Z").unwrap();
        assert_eq!(seoul.epoch_millis, utc.epoch_millis);
        assert_eq!(seoul.local_minute_of_day, 9 * 60);
        assert_eq!(utc.local_minute_of_day, 0);
        assert_eq!(
            format_utc_timestamp(seoul.epoch_millis),
            "2026-07-21T00:00:00.000Z"
        );
    }

    #[test]
    fn us_day_market_crosses_midnight_without_resetting_the_trading_session() {
        let windows = vec![
            SessionWindow {
                kind: "day_market".into(),
                open_minute: 1_200,
                close_minute: 1_440,
                local_date_offset: -1,
            },
            SessionWindow {
                kind: "day_market".into(),
                open_minute: 0,
                close_minute: 240,
                local_date_offset: 0,
            },
            SessionWindow {
                kind: "pre_market".into(),
                open_minute: 240,
                close_minute: 570,
                local_date_offset: 0,
            },
            SessionWindow {
                kind: "regular_market".into(),
                open_minute: 570,
                close_minute: 960,
                local_date_offset: 0,
            },
            SessionWindow {
                kind: "after_market".into(),
                open_minute: 960,
                close_minute: 1_200,
                local_date_offset: 0,
            },
        ];
        let make_bar = |timestamp: &str, close: f64| MinuteBar {
            timestamp: timestamp.into(),
            session_date: "2026-07-22".into(),
            open: close,
            high: close,
            low: close,
            close,
            volume: Some(10.0),
            amount: Some(close * 10.0),
            complete: true,
        };
        let mut us = instrument("USD:AAPL", 0.0);
        us.market = "US".into();
        us.currency = "USD".into();
        us.bars = vec![
            make_bar("2026-07-22T00:00:00-04:00", 200.0),
            make_bar("2026-07-22T00:01:00-04:00", 201.0),
        ];
        us.session_windows = windows.clone();
        us.session_window_overrides = vec![SessionWindowOverride {
            session_date: "2026-07-22".into(),
            windows,
        }];
        us.session_start_confirmed_dates = vec!["2026-07-22".into()];
        us.complete_session_dates.clear();
        us.anchored_vwap_timestamp = None;
        us.orderbook = None;
        us.trade_stats = None;
        us.position = None;
        let mut input = request(ResponseMode::FullSeries, false);
        input.instruments = vec![us.clone()];
        input.volume_profile = None;
        validate_request(&input).unwrap();
        let next = next_scheduled_close_epoch(&us, &us.bars[0], 1)
            .unwrap()
            .map(format_utc_timestamp);
        assert_eq!(next.as_deref(), Some("2026-07-22T04:01:00.000Z"));
        let points = session_vwap_points(&us, 1).unwrap();
        assert_eq!(points.len(), 2);
        assert!(points[1].values["session_vwap"].is_some());

        input.instruments[0].bars[0].session_date = "2026-07-21".into();
        assert!(
            validate_request(&input)
                .unwrap_err()
                .to_string()
                .contains("outside configured session windows")
        );
    }

    #[test]
    fn batch_reuses_indicators_and_exposes_intraday_scanner_and_profile_results() {
        let result = analyze_scalping(&request(ResponseMode::FullSeries, true), None).unwrap();
        assert_eq!(result.schema_version, SCALPING_RESULT_SCHEMA_VERSION);
        assert_eq!(result.indicator_engine_version, INDICATOR_ENGINE_VERSION);
        assert_eq!(result.instruments.len(), 2);
        assert_eq!(result.instruments[0].indicators.len(), 2);
        assert_eq!(
            result.instruments[0].indicators[0]
                .points
                .as_ref()
                .unwrap()
                .last()
                .unwrap()
                .timestamp,
            result.instruments[0]
                .intraday
                .session_vwap
                .points
                .as_ref()
                .unwrap()
                .last()
                .unwrap()
                .timestamp
        );
        let profile = result.instruments[1]
            .volume_profile
            .as_ref()
            .expect("requested profile is attached to 005930");
        assert_eq!(profile.availability.status, AvailabilityStatus::Available);
        assert_eq!(profile.profile.as_ref().unwrap().buckets.len(), 24);
        assert_eq!(
            result.instruments[1]
                .scanner_metrics
                .normalized_atr
                .availability
                .status,
            AvailabilityStatus::Available
        );
        assert!(
            result.instruments[1]
                .scanner_metrics
                .bollinger_width_expansion
                .value
                .is_some()
        );
        assert!(
            result.instruments[1]
                .scanner_metrics
                .relative_volume
                .value
                .is_some()
        );
        assert!(result.instruments[0].volume_profile.is_none());
    }

    #[test]
    fn latest_summary_omits_long_series_and_profile_buckets() {
        let result = analyze_scalping(&request(ResponseMode::LatestSummary, false), None).unwrap();
        let instrument = &result.instruments[0];
        assert!(instrument.indicators[0].points.is_none());
        assert!(instrument.indicators[0].latest.is_some());
        assert!(instrument.intraday.session_vwap.points.is_none());
        assert!(instrument.intraday.session_vwap.latest.is_some());
        assert!(instrument.signals.as_ref().unwrap().points.is_none());
        assert!(instrument.signals.as_ref().unwrap().latest.is_some());
        assert!(
            instrument
                .volume_profile
                .as_ref()
                .unwrap()
                .profile
                .as_ref()
                .unwrap()
                .buckets
                .is_empty()
        );
    }

    #[test]
    fn timestamp_anchored_shared_vwap_maps_back_from_the_synthetic_axis() {
        let mut request = request(ResponseMode::FullSeries, false);
        request.volume_profile = None;
        let anchor = request.instruments[0].bars[30].timestamp.clone();
        request.indicators = vec![IndicatorDefinition {
            id: "shared-anchored-vwap".into(),
            kind: IndicatorKind::VwapAnchoredVwap,
            parameters: BTreeMap::from([
                ("anchor".into(), json!("user_date")),
                ("anchor_date".into(), json!(anchor)),
                ("mode".into(), json!("anchored")),
            ]),
            instrument_keys: None,
        }];
        let result = analyze_scalping(&request, None).unwrap();
        let calculation = &result.instruments[0].indicators[0];
        assert_eq!(calculation.parameters["anchor_date"], anchor);
        assert_eq!(
            calculation.metadata["resolved_anchor_timestamp"],
            request.instruments[0].bars[30].timestamp
        );
        assert!(
            calculation
                .points
                .as_ref()
                .unwrap()
                .iter()
                .take(30)
                .all(|point| point.state != PointState::Available)
        );
        assert_eq!(
            calculation.points.as_ref().unwrap()[30].state,
            PointState::Available
        );
    }

    #[test]
    fn malformed_forming_duplicate_and_misaligned_bars_are_rejected() {
        let mut forming = request(ResponseMode::FullSeries, false);
        forming.instruments[0].bars[0].complete = false;
        assert!(
            analyze_scalping(&forming, None)
                .unwrap_err()
                .to_string()
                .contains("finalized bars only")
        );

        let mut duplicate = request(ResponseMode::FullSeries, false);
        duplicate.instruments[0].bars[1].timestamp =
            duplicate.instruments[0].bars[0].timestamp.clone();
        assert!(
            analyze_scalping(&duplicate, None)
                .unwrap_err()
                .to_string()
                .contains("strictly timestamp-ascending")
        );

        let mut unsupported = request(ResponseMode::FullSeries, false);
        unsupported.interval_minutes = 2;
        assert!(
            analyze_scalping(&unsupported, None)
                .unwrap_err()
                .to_string()
                .contains("one of 1, 5, 15, 30, or 60")
        );
    }

    #[test]
    fn missing_volume_and_snapshots_remain_explicitly_unavailable() {
        let mut request = request(ResponseMode::LatestSummary, false);
        let instrument = &mut request.instruments[0];
        for bar in &mut instrument.bars {
            bar.volume = None;
        }
        instrument.orderbook = None;
        instrument.trade_stats = None;
        instrument.anchored_vwap_timestamp = None;
        request.volume_profile = None;
        let result = analyze_scalping(&request, None).unwrap();
        let instrument = &result.instruments[0];
        assert_eq!(
            instrument.intraday.session_vwap.availability.status,
            AvailabilityStatus::VolumeUnavailable
        );
        assert_eq!(
            instrument.intraday.anchored_vwap.availability.status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(
            instrument.intraday.orderbook_imbalance.availability.status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(
            instrument.intraday.execution_strength.availability.status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(
            instrument.data_quality.status,
            AvailabilityStatus::VolumeUnavailable
        );
        assert_eq!(
            instrument.scanner_metrics.spread_bps.availability.status,
            AvailabilityStatus::Unavailable
        );
    }

    #[test]
    fn truncated_session_is_not_presented_as_full_session_data() {
        let mut request = request(ResponseMode::LatestSummary, false);
        request.volume_profile = None;
        request.instruments[0].session_start_confirmed_dates.clear();
        request.instruments[0].complete_session_dates.clear();
        let result = analyze_scalping(&request, None).unwrap();
        let instrument = &result.instruments[0];
        assert_eq!(
            instrument.intraday.session_vwap.availability.status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(
            instrument.intraday.opening_range_15.availability.status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(
            instrument
                .scanner_metrics
                .day_range_ratio
                .availability
                .status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(
            instrument
                .scanner_metrics
                .trading_amount
                .availability
                .status,
            AvailabilityStatus::Unavailable
        );
        assert_eq!(instrument.data_quality.status, AvailabilityStatus::Partial);
    }

    #[test]
    fn unrecovered_bar_gap_suppresses_entries_and_session_aggregates() {
        let mut request = request(ResponseMode::LatestSummary, false);
        request.volume_profile = None;
        let latest_date = request.instruments[0]
            .bars
            .last()
            .unwrap()
            .session_date
            .clone();
        request.instruments[0]
            .complete_session_dates
            .retain(|date| date != &latest_date);
        let gap_index = request.instruments[0].bars.len() - 10;
        request.instruments[0].bars.remove(gap_index);
        let result = analyze_scalping(&request, None).unwrap();
        let instrument = &result.instruments[0];
        assert_eq!(
            instrument
                .intraday
                .session_vwap
                .latest
                .as_ref()
                .unwrap()
                .state,
            PointState::Unavailable
        );
        assert_eq!(
            instrument
                .scanner_metrics
                .day_range_ratio
                .availability
                .status,
            AvailabilityStatus::Unavailable
        );
        let signal = instrument
            .signals
            .as_ref()
            .unwrap()
            .latest
            .as_ref()
            .unwrap();
        assert_ne!(signal.status, AssistanceStatus::EntryCandidate);
        assert!(
            signal
                .rationale
                .contains(&"unrecovered_same_session_bar_gap".to_owned())
        );
        assert_eq!(instrument.data_quality.same_session_gap_count, 1);
    }

    #[test]
    fn absent_position_still_allows_a_non_executing_entry_candidate() {
        let mut request = request(ResponseMode::LatestSummary, false);
        request.volume_profile = None;
        request.instruments[0].position = None;
        let result = analyze_scalping(&request, None).unwrap();
        let signal = result.instruments[0]
            .signals
            .as_ref()
            .unwrap()
            .latest
            .as_ref()
            .unwrap();
        assert_eq!(signal.status, AssistanceStatus::EntryCandidate);
        assert!(!signal.position_known);
        assert!(signal.disclaimer.contains("not_an_order_instruction"));
    }

    #[test]
    fn post_close_position_before_next_quote_changes_only_the_current_label() {
        let mut request = request(ResponseMode::LatestSummary, false);
        request.volume_profile = None;
        let last = request.instruments[0].bars.last().unwrap();
        let close_epoch = parse_timestamp(&last.timestamp).unwrap().epoch_millis;
        let average_price = last.close - 1.0;
        let position_timestamp = format_utc_timestamp(close_epoch + 30_000);
        let quote_timestamp = format_utc_timestamp(close_epoch + 45_000);
        request.instruments[0].position = Some(PositionSnapshot {
            as_of_timestamp: position_timestamp,
            quantity: 10.0,
            average_price: Some(average_price),
        });
        request.instruments[0].next_valid_quote_timestamp = Some(quote_timestamp.clone());
        let result = analyze_scalping(&request, None).unwrap();
        let signal = result.instruments[0]
            .signals
            .as_ref()
            .unwrap()
            .latest
            .as_ref()
            .unwrap();
        assert_eq!(signal.status, AssistanceStatus::Hold);
        assert!(signal.position_known);
        assert_eq!(
            signal.earliest_eligible_timestamp.as_deref(),
            Some(quote_timestamp.as_str())
        );
        assert!(
            signal
                .eligibility_basis
                .contains("position_used_for_label_only")
        );
        assert!(signal.rationale.iter().any(|reason| reason
            == "post_close_position_used_for_current_status_label_only_not_technical_conditions"));

        request.instruments[0].next_valid_quote_timestamp = None;
        assert!(
            analyze_scalping(&request, None)
                .unwrap_err()
                .to_string()
                .contains("requires a later next_valid_quote_timestamp")
        );
    }

    #[test]
    fn appending_future_bars_never_changes_existing_series_or_signals() {
        let mut base = request(ResponseMode::FullSeries, false);
        base.volume_profile = None;
        let base_result = analyze_scalping(&base, None).unwrap();
        let original_len = base.instruments[0].bars.len();

        let mut extended = base.clone();
        extended.instruments[0]
            .bars
            .extend(bars(0.0, 7, 25).into_iter().skip(original_len));
        let extended_result = analyze_scalping(&extended, None).unwrap();
        let before = &base_result.instruments[0];
        let after = &extended_result.instruments[0];
        for (before_calculation, after_calculation) in
            before.indicators.iter().zip(&after.indicators)
        {
            assert_eq!(
                before_calculation.points.as_ref().unwrap(),
                &after_calculation.points.as_ref().unwrap()[..original_len]
            );
        }
        assert_eq!(
            metric_points(&before.intraday.session_vwap),
            &metric_points(&after.intraday.session_vwap)[..original_len]
        );
        assert_eq!(
            metric_points(&before.intraday.anchored_vwap),
            &metric_points(&after.intraday.anchored_vwap)[..original_len]
        );
        assert_eq!(
            metric_points(&before.intraday.time_of_day_relative_volume),
            &metric_points(&after.intraday.time_of_day_relative_volume)[..original_len]
        );
        assert_eq!(
            before.signals.as_ref().unwrap().points.as_ref().unwrap(),
            &after.signals.as_ref().unwrap().points.as_ref().unwrap()[..original_len]
        );
    }

    #[test]
    fn every_signal_is_eligible_strictly_after_its_finalized_bar() {
        let result = analyze_scalping(&request(ResponseMode::FullSeries, false), None).unwrap();
        let signals = result.instruments[0]
            .signals
            .as_ref()
            .unwrap()
            .points
            .as_ref()
            .unwrap();
        assert!(signals.iter().all(|signal| {
            parse_timestamp(signal.earliest_eligible_timestamp.as_deref().unwrap())
                .unwrap()
                .epoch_millis
                > parse_timestamp(&signal.calculation_timestamp)
                    .unwrap()
                    .epoch_millis
        }));
        assert!(signals.iter().all(|signal| {
            signal.disclaimer.contains("not_an_order_instruction")
                && signal
                    .confidence_semantics
                    .contains("not_success_probability")
        }));
    }

    #[test]
    fn integrated_nxt_windows_allow_only_scheduled_breaks_and_keep_regular_opening_range() {
        let mut full_input = request(ResponseMode::FullSeries, false);
        full_input.instruments = vec![integrated_session_instrument()];
        let full_result = analyze_scalping(&full_input, None).unwrap();
        assert_eq!(
            full_result.scalping_engine_version,
            "scalping-analysis/1.4.0"
        );
        let full_instrument = &full_result.instruments[0];
        assert_eq!(full_instrument.data_quality.same_session_gap_count, 0);
        assert_eq!(
            full_instrument.data_quality.status,
            AvailabilityStatus::Available
        );

        let mut early_input = full_input.clone();
        early_input.output_projection.series_tail_points = 512;
        early_input.instruments[0]
            .bars
            .retain(|bar| bar.timestamp.as_str() <= "2026-07-21T15:55:00+09:00");
        early_input.instruments[0].complete_session_dates.clear();
        let early_result = analyze_scalping(&early_input, None).unwrap();
        let instrument = &early_result.instruments[0];

        let vwap = metric_points(&instrument.intraday.session_vwap);
        let after = vwap
            .iter()
            .find(|point| point.timestamp == "2026-07-21T15:41:00+09:00")
            .unwrap();
        assert_eq!(after.state, PointState::Available);
        assert_eq!(
            instrument
                .intraday
                .session_vwap
                .metadata
                .get("accumulation_scope"),
            Some(&json!("all_caller_configured_session_windows")),
        );

        let opening = metric_points(&instrument.intraday.opening_range_5);
        let pre_market = opening
            .iter()
            .find(|point| point.timestamp == "2026-07-21T08:05:00+09:00")
            .unwrap();
        assert_eq!(pre_market.state, PointState::Warmup);
        let regular_ready = opening
            .iter()
            .find(|point| point.timestamp == "2026-07-21T09:05:00+09:00")
            .unwrap();
        assert_eq!(regular_ready.state, PointState::Available);

        let signals = instrument
            .signals
            .as_ref()
            .unwrap()
            .points
            .as_ref()
            .unwrap();
        let pre_close = signals
            .iter()
            .find(|signal| signal.calculation_timestamp == "2026-07-21T08:50:00+09:00")
            .unwrap();
        assert_eq!(
            pre_close.earliest_eligible_timestamp.as_deref(),
            Some("2026-07-21T00:01:00.000Z"),
        );
        let regular_close = signals
            .iter()
            .find(|signal| signal.calculation_timestamp == "2026-07-21T15:30:00+09:00")
            .unwrap();
        assert_eq!(
            regular_close.earliest_eligible_timestamp.as_deref(),
            Some("2026-07-21T06:41:00.000Z"),
        );
        let after_ten = signals
            .iter()
            .find(|signal| signal.calculation_timestamp == "2026-07-21T15:50:00+09:00")
            .unwrap();
        assert_eq!(
            after_ten.multi_timeframe_trends.get("15m"),
            Some(&Some(TrendDirection::Bullish))
        );
        let after_fifteen = signals
            .iter()
            .find(|signal| signal.calculation_timestamp == "2026-07-21T15:55:00+09:00")
            .unwrap();
        assert_eq!(
            after_fifteen.multi_timeframe_trends.get("15m"),
            Some(&Some(TrendDirection::Bearish))
        );
        let after_close = full_instrument
            .signals
            .as_ref()
            .unwrap()
            .points
            .as_ref()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(
            after_close.calculation_timestamp,
            "2026-07-21T20:00:00+09:00"
        );
        assert_eq!(after_close.earliest_eligible_timestamp, None);
        assert_eq!(after_close.status, AssistanceStatus::Watch);
        assert_eq!(
            after_close.eligibility_basis,
            "caller_configured_session_ended_next_valid_quote_unavailable",
        );
        assert!(
            after_close
                .rationale
                .iter()
                .any(|value| value == "next_valid_market_timestamp_unavailable")
        );
    }

    #[test]
    fn opening_ranges_do_not_expand_a_short_range_to_a_coarser_selected_interval() {
        let mut instrument = integrated_session_instrument();
        instrument
            .session_windows
            .retain(|window| window.kind == "regular_market");
        instrument.bars.retain(|bar| {
            let minute = parse_timestamp(&bar.timestamp).unwrap().local_minute_of_day;
            minute > 540 && minute <= 930 && (minute - 540).is_multiple_of(60)
        });
        instrument.session_start_confirmed_dates = vec!["2026-07-21".into()];
        instrument.complete_session_dates.clear();
        instrument.anchored_vwap_timestamp = Some(instrument.bars[0].timestamp.clone());
        instrument.orderbook = None;
        instrument.trade_stats = None;
        instrument.position = None;

        let mut input = request(ResponseMode::LatestSummary, false);
        input.interval_minutes = 60;
        input.instruments = vec![instrument];
        input.volume_profile = None;
        let result = analyze_scalping(&input, None).unwrap();
        let intraday = &result.instruments[0].intraday;
        for series in [
            &intraday.opening_range_5,
            &intraday.opening_range_15,
            &intraday.opening_range_30,
        ] {
            assert_eq!(series.availability.status, AvailabilityStatus::Unavailable);
            assert_eq!(
                series.availability.reason,
                "selected_interval_coarser_than_opening_range",
            );
            assert_eq!(
                series.latest.as_ref().unwrap().state,
                PointState::Unavailable,
            );
            assert_eq!(series.metadata.get("effective_minutes"), Some(&Value::Null));
            assert_eq!(
                series.metadata.get("source_interval_minutes"),
                Some(&json!(60))
            );
        }
    }

    #[test]
    fn six_full_integrated_sessions_make_five_session_time_of_day_rvol_available() {
        let template = integrated_session_instrument();
        let mut instrument = template.clone();
        instrument.bars.clear();
        instrument.session_start_confirmed_dates.clear();
        instrument.complete_session_dates.clear();
        for day in 21..=26 {
            let date = format!("2026-07-{day:02}");
            instrument.session_start_confirmed_dates.push(date.clone());
            instrument.complete_session_dates.push(date.clone());
            instrument
                .bars
                .extend(template.bars.iter().cloned().map(|mut bar| {
                    bar.timestamp = format!("{date}{}", &bar.timestamp[10..]);
                    bar.session_date = date.clone();
                    bar
                }));
        }
        instrument.anchored_vwap_timestamp = Some(instrument.bars[0].timestamp.clone());
        instrument.next_valid_quote_timestamp = None;
        instrument.orderbook = None;
        instrument.trade_stats = None;
        instrument.position = None;

        let mut input = request(ResponseMode::LatestSummary, false);
        input.instruments = vec![instrument];
        input.volume_profile = None;
        let result = analyze_scalping(&input, None).unwrap();
        let relative_volume = &result.instruments[0].intraday.time_of_day_relative_volume;
        assert_eq!(
            relative_volume.availability.status,
            AvailabilityStatus::Available
        );
        assert_eq!(
            relative_volume
                .latest
                .as_ref()
                .unwrap()
                .values
                .get("relative_volume"),
            Some(&Some(1.0)),
        );
        assert_eq!(result.diagnostics.total_bar_count, 4_200);
    }

    #[test]
    fn regular_only_instrument_does_not_infer_an_nxt_after_market_transition() {
        let mut instrument = integrated_session_instrument();
        instrument
            .session_windows
            .retain(|window| window.kind == "regular_market");
        instrument.bars.retain(|bar| {
            let minute = parse_timestamp(&bar.timestamp).unwrap().local_minute_of_day;
            minute > 540 && minute <= 930
        });
        instrument.anchored_vwap_timestamp = Some(instrument.bars[0].timestamp.clone());
        let mut input = request(ResponseMode::FullSeries, false);
        input.instruments = vec![instrument];

        let result = analyze_scalping(&input, None).unwrap();
        let signals = result.instruments[0]
            .signals
            .as_ref()
            .unwrap()
            .points
            .as_ref()
            .unwrap();
        let regular_close = signals.last().unwrap();
        assert_eq!(
            regular_close.calculation_timestamp,
            "2026-07-21T15:30:00+09:00",
        );
        assert_eq!(regular_close.earliest_eligible_timestamp, None);
        assert_eq!(regular_close.status, AssistanceStatus::Watch);
        assert_eq!(
            regular_close.eligibility_basis,
            "caller_configured_session_ended_next_valid_quote_unavailable",
        );
        assert!(!signals.iter().any(|signal| {
            signal.earliest_eligible_timestamp.as_deref() == Some("2026-07-21T06:41:00.000Z")
        }));
    }

    #[test]
    fn us_early_close_window_has_no_post_close_signal_eligibility() {
        let date = "2026-07-21";
        let bars = (571..=780)
            .enumerate()
            .map(|(index, minute)| {
                let price = 200.0 + index as f64 / 100.0;
                MinuteBar {
                    timestamp: format!("{date}T{:02}:{:02}:00-04:00", minute / 60, minute % 60,),
                    session_date: date.into(),
                    open: price,
                    high: price + 0.2,
                    low: price - 0.2,
                    close: price + 0.05,
                    volume: Some(1_000.0 + index as f64),
                    amount: None,
                    complete: true,
                }
            })
            .collect::<Vec<_>>();
        let mut instrument = integrated_session_instrument();
        instrument.key = "USD:AAPL".into();
        instrument.symbol = "AAPL".into();
        instrument.market = "US".into();
        instrument.currency = "USD".into();
        instrument.session_windows = vec![SessionWindow {
            kind: "regular_market".into(),
            open_minute: 570,
            close_minute: 780,
            local_date_offset: 0,
        }];
        instrument.anchored_vwap_timestamp = Some(bars[0].timestamp.clone());
        instrument.bars = bars;
        let mut input = request(ResponseMode::FullSeries, false);
        input.instruments = vec![instrument];
        input.volume_profile = None;

        let result = analyze_scalping(&input, None).unwrap();
        let last = result.instruments[0]
            .signals
            .as_ref()
            .unwrap()
            .points
            .as_ref()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(last.calculation_timestamp, "2026-07-21T13:00:00-04:00");
        assert_eq!(last.earliest_eligible_timestamp, None);
        assert_eq!(last.status, AssistanceStatus::Watch);
        assert_eq!(
            last.eligibility_basis,
            "caller_configured_session_ended_next_valid_quote_unavailable",
        );
    }

    #[test]
    fn integrated_nxt_windows_do_not_hide_a_real_missing_bar() {
        let mut input = request(ResponseMode::LatestSummary, false);
        let mut instrument = integrated_session_instrument();
        instrument
            .bars
            .retain(|bar| bar.timestamp != "2026-07-21T10:00:00+09:00");
        instrument.complete_session_dates.clear();
        input.instruments = vec![instrument];
        let result = analyze_scalping(&input, None).unwrap();
        assert_eq!(result.instruments[0].data_quality.same_session_gap_count, 1);
        assert_eq!(
            result.instruments[0].data_quality.status,
            AvailabilityStatus::Partial
        );
        let signal = result.instruments[0]
            .signals
            .as_ref()
            .unwrap()
            .latest
            .as_ref()
            .unwrap();
        assert!(
            signal
                .rationale
                .iter()
                .any(|value| value == "unrecovered_same_session_bar_gap")
        );
    }

    #[test]
    fn non_divisible_integrated_windows_disclose_omitted_higher_interval_tails() {
        let mut instrument = integrated_session_instrument();
        let windows = instrument.session_windows.clone();
        instrument.bars.retain(|bar| {
            let minute = parse_timestamp(&bar.timestamp).unwrap().local_minute_of_day;
            let window = windows
                .iter()
                .find(|window| minute > window.open_minute && minute <= window.close_minute)
                .unwrap();
            (minute - window.open_minute).is_multiple_of(15)
        });
        instrument.complete_session_dates.clear();
        instrument.anchored_vwap_timestamp = Some(instrument.bars[0].timestamp.clone());
        let mut input = request(ResponseMode::LatestSummary, false);
        input.interval_minutes = 15;
        input.instruments = vec![instrument];
        let result = analyze_scalping(&input, None).unwrap();
        let instrument = &result.instruments[0];
        assert_eq!(instrument.data_quality.status, AvailabilityStatus::Partial);
        assert!(
            instrument
                .data_quality
                .reasons
                .iter()
                .any(|reason| reason == "scheduled_window_tail_omitted")
        );
        assert!(
            instrument
                .signals
                .as_ref()
                .unwrap()
                .latest
                .as_ref()
                .unwrap()
                .rationale
                .iter()
                .any(|reason| reason == "scheduled_window_tail_omitted")
        );
    }

    #[test]
    fn profile_and_snapshot_limits_are_strict() {
        let mut invalid = request(ResponseMode::FullSeries, false);
        invalid.volume_profile.as_mut().unwrap().bucket_count = 201;
        assert!(
            analyze_scalping(&invalid, None)
                .unwrap_err()
                .to_string()
                .contains("5..=200")
        );
        let mut invalid_book = request(ResponseMode::FullSeries, false);
        invalid_book.instruments[0]
            .orderbook
            .as_mut()
            .unwrap()
            .best_ask = None;
        assert!(
            analyze_scalping(&invalid_book, None)
                .unwrap_err()
                .to_string()
                .contains("must be supplied together")
        );
        let mut invalid_projection = request(ResponseMode::FullSeries, false);
        invalid_projection.output_projection.series_tail_points = 513;
        assert!(
            analyze_scalping(&invalid_projection, None)
                .unwrap_err()
                .to_string()
                .contains("series_tail_points must be in 1..=512")
        );
        let mut invalid_selection = request(ResponseMode::FullSeries, false);
        invalid_selection.output_projection.signal_snapshots = vec![SignalSnapshotSelection {
            instrument_key: invalid_selection.instruments[0].key.clone(),
            timestamps: vec!["2026-07-21T09:00:00+09:00".into()],
        }];
        assert!(
            analyze_scalping(&invalid_selection, None)
                .unwrap_err()
                .to_string()
                .contains("must reference supplied finalized bars")
        );
    }

    #[test]
    fn versioned_worker_job_dispatches_batch_and_exact_artifacts() {
        let request = request(ResponseMode::LatestSummary, true);
        let input = WorkerInput {
            schema_version: WORKER_SCHEMA_VERSION.into(),
            engine_version: ENGINE_VERSION.into(),
            run_id: "scalping-dispatch-test".into(),
            job_kind: JobKind::ScalpingAnalysis,
            data_revision: "intraday-revision-1".into(),
            request_hash: "a".repeat(64),
            payload: json!({"scalping_analysis": request}),
        };
        let output = crate::compute::compute(&input).unwrap();
        output.validate_for(&input).unwrap();
        assert_eq!(output.job_kind, JobKind::ScalpingAnalysis);
        assert_eq!(
            output.result.as_ref().unwrap()["schema_version"],
            SCALPING_RESULT_SCHEMA_VERSION
        );
        let artifacts = output.artifacts.unwrap();
        assert_eq!(artifacts.len(), 3);
        assert!(
            artifacts
                .iter()
                .any(|artifact| artifact.artifact_type == "technical-indicators")
        );
        assert!(
            artifacts
                .iter()
                .any(|artifact| artifact.artifact_type == "technical-signals")
        );
        assert!(
            artifacts
                .iter()
                .any(|artifact| artifact.artifact_type == "technical-diagnostics")
        );
    }

    #[test]
    fn twenty_instrument_batch_is_one_deterministic_engine_request() {
        let mut request = request(ResponseMode::LatestSummary, false);
        request.instruments = (0..20)
            .map(|index| instrument(&format!("KRW:{index:06}"), index as f64 * 3.0))
            .collect();
        request.volume_profile = Some(VolumeProfileConfig {
            instrument_keys: vec!["KRW:000000".into()],
            bucket_count: 24,
            value_area_percent: 70.0,
            price_source: "typical_price".into(),
        });
        let started = Instant::now();
        let first = analyze_scalping(&request, None).unwrap();
        let elapsed = started.elapsed();
        let second = analyze_scalping(&request, None).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.instruments.len(), 20);
        assert_eq!(first.diagnostics.total_bar_count, 3_000);
        eprintln!("20-instrument/3000-bar scalping batch: {elapsed:?}");
    }

    #[test]
    fn twenty_instrument_four_thousand_nine_hundred_bar_response_is_bounded() {
        let template = integrated_session_instrument();
        let instruments = (0..20)
            .map(|index| {
                let key = format!("KRW:{index:06}");
                let offset = index as f64 * 10.0;
                let mut instrument = template.clone();
                instrument.key = key;
                instrument.symbol = format!("{index:06}");
                instrument.bars.clear();
                instrument.session_start_confirmed_dates.clear();
                instrument.complete_session_dates.clear();
                for day in 21..=27 {
                    let date = format!("2026-07-{day:02}");
                    instrument.session_start_confirmed_dates.push(date.clone());
                    instrument.complete_session_dates.push(date.clone());
                    instrument
                        .bars
                        .extend(template.bars.iter().cloned().map(|mut bar| {
                            bar.timestamp = format!("{date}{}", &bar.timestamp[10..]);
                            bar.session_date = date.clone();
                            bar.open += offset;
                            bar.high += offset;
                            bar.low += offset;
                            bar.close += offset;
                            bar.amount = bar.volume.map(|volume| volume * bar.close);
                            bar
                        }));
                }
                instrument.anchored_vwap_timestamp =
                    Some(instrument.bars.first().unwrap().timestamp.clone());
                instrument.next_valid_quote_timestamp = None;
                instrument.orderbook = None;
                instrument.trade_stats = None;
                instrument.position = None;
                assert_eq!(instrument.bars.len(), 4_900);
                instrument
            })
            .collect::<Vec<_>>();
        let signal_snapshots = instruments
            .iter()
            .map(|instrument| SignalSnapshotSelection {
                instrument_key: instrument.key.clone(),
                timestamps: instrument
                    .bars
                    .iter()
                    .map(|bar| bar.timestamp.clone())
                    .collect(),
            })
            .collect::<Vec<_>>();
        let profile_keys = instruments
            .iter()
            .map(|instrument| instrument.key.clone())
            .collect::<Vec<_>>();
        let mut input = request(ResponseMode::FullSeries, false);
        input.instruments = instruments;
        input.indicators = vec![
            IndicatorDefinition {
                id: "scanner-realized-volatility".into(),
                kind: IndicatorKind::HistoricalVolatility,
                parameters: BTreeMap::from([
                    ("period".into(), json!(20)),
                    ("annualization".into(), json!(1)),
                    ("return_type".into(), json!("log")),
                ]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "scanner-natr".into(),
                kind: IndicatorKind::NormalizedAtr,
                parameters: BTreeMap::from([("period".into(), json!(14))]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "scanner-bollinger-width".into(),
                kind: IndicatorKind::BollingerBandWidthPercentB,
                parameters: BTreeMap::from([
                    ("period".into(), json!(20)),
                    ("stddev_multiplier".into(), json!(2)),
                ]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "scanner-rvol".into(),
                kind: IndicatorKind::RelativeVolume,
                parameters: BTreeMap::from([("period".into(), json!(20))]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "trend-ema-fast".into(),
                kind: IndicatorKind::Ema,
                parameters: BTreeMap::from([("period".into(), json!(20))]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "trend-ema-slow".into(),
                kind: IndicatorKind::Ema,
                parameters: BTreeMap::from([("period".into(), json!(50))]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "trend-macd".into(),
                kind: IndicatorKind::Macd,
                parameters: BTreeMap::from([
                    ("fast_period".into(), json!(12)),
                    ("slow_period".into(), json!(26)),
                    ("signal_period".into(), json!(9)),
                ]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "trend-adx".into(),
                kind: IndicatorKind::AdxDmi,
                parameters: BTreeMap::from([("period".into(), json!(14))]),
                instrument_keys: None,
            },
            IndicatorDefinition {
                id: "trend-supertrend".into(),
                kind: IndicatorKind::Supertrend,
                parameters: BTreeMap::from([
                    ("atr_period".into(), json!(10)),
                    ("multiplier".into(), json!(3)),
                ]),
                instrument_keys: None,
            },
        ];
        input.volume_profile = Some(VolumeProfileConfig {
            instrument_keys: profile_keys,
            bucket_count: 200,
            value_area_percent: 70.0,
            price_source: "typical_price".into(),
        });
        input.output_projection = ScalpingOutputProjection {
            series_tail_points: 180,
            signal_snapshots,
        };

        let started = Instant::now();
        let result = analyze_scalping(&input, None).unwrap();
        let serialized_bytes = serde_json::to_vec(&result).unwrap().len();
        assert_eq!(result.diagnostics.total_bar_count, 98_000);
        assert_eq!(result.diagnostics.signal_snapshot_count, 98_000);
        assert_eq!(result.instruments.len(), 20);
        for instrument in &result.instruments {
            assert_eq!(instrument.signal_snapshots.len(), 4_900);
            assert!(instrument.indicators.iter().all(|calculation| {
                calculation
                    .points
                    .as_ref()
                    .is_none_or(|points| points.len() <= 180)
            }));
            assert!(
                instrument
                    .signals
                    .as_ref()
                    .unwrap()
                    .points
                    .as_ref()
                    .unwrap()
                    .len()
                    <= 180
            );
            for series in [
                &instrument.intraday.session_vwap,
                &instrument.intraday.anchored_vwap,
                &instrument.intraday.opening_range_5,
                &instrument.intraday.opening_range_15,
                &instrument.intraday.opening_range_30,
                &instrument.intraday.time_of_day_relative_volume,
                &instrument.intraday.previous_session_levels,
                &instrument.intraday.current_session_levels,
            ] {
                assert!(series.points.as_ref().unwrap().len() <= 180);
            }
            assert_eq!(
                instrument
                    .volume_profile
                    .as_ref()
                    .unwrap()
                    .profile
                    .as_ref()
                    .unwrap()
                    .buckets
                    .len(),
                200
            );
        }
        assert!(
            serialized_bytes < 64 * 1024 * 1024,
            "bounded 20x4900 scalping response was {serialized_bytes} bytes"
        );
        eprintln!(
            "20-instrument/98000-bar bounded response: {serialized_bytes} bytes in {:?}",
            started.elapsed()
        );
    }
}
