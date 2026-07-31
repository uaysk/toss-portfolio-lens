use std::fs::{create_dir_all, write};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use portfolio_lens_compute::date::add_days;
use portfolio_lens_compute::indicators::{
    AdjustmentPolicy, IndicatorDefinition, IndicatorKind, InstrumentSeries, InstrumentType,
    OhlcvBar, ResponseMode, TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION, TechnicalAnalysisRequest,
    analyze, clear_indicator_cache, indicator_cache_stats, without_indicator_cache,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const DEFAULT_BAR_COUNT: usize = 20_000;
const DEFAULT_ITERATIONS: usize = 15;
const MINIMUM_IMPROVEMENT_PERCENT: f64 = 20.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Distribution {
    samples_ms: Vec<f64>,
    p50_ms: f64,
    p95_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema_version: &'static str,
    generated_at: String,
    bar_count: usize,
    indicator_count: usize,
    iterations: usize,
    result_sha256: String,
    uncached: Distribution,
    cached: Distribution,
    p50_improvement_percent: f64,
    p95_improvement_percent: f64,
    cache: portfolio_lens_compute::indicators::IndicatorCacheStats,
    minimum_improvement_percent: f64,
    passed: bool,
}

fn environment_usize(name: &str, default: usize) -> Result<usize> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .with_context(|| format!("{name} must be a positive integer"))
            .and_then(|value| {
                ensure!(value > 0, "{name} must be positive");
                Ok(value)
            }),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

fn definition(
    id: impl Into<String>,
    kind: IndicatorKind,
    parameters: impl IntoIterator<Item = (&'static str, Value)>,
) -> IndicatorDefinition {
    IndicatorDefinition {
        id: id.into(),
        kind,
        parameters: parameters
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
        instrument_keys: Some(vec!["benchmark".into()]),
    }
}

fn request(bar_count: usize) -> Result<TechnicalAnalysisRequest> {
    let bars = (0..bar_count)
        .map(|index| {
            let cycle = (index % 251) as f64;
            let trend = index as f64 * 0.0025;
            let close = 100.0 + trend + (cycle / 19.0).sin() * 3.5;
            Ok(OhlcvBar {
                date: add_days("2000-01-01", index as i64)?,
                open: close - 0.2,
                high: close + 1.1 + (cycle % 7.0) * 0.01,
                low: close - 1.0 - (cycle % 5.0) * 0.01,
                close,
                volume: Some(100_000.0 + (index % 1_000) as f64 * 100.0),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut indicators = Vec::new();
    for index in 0..4 {
        indicators.push(definition(
            format!("sma-{index}"),
            IndicatorKind::Sma,
            [("period", json!(20)), ("source", json!("close"))],
        ));
        indicators.push(definition(
            format!("ema-{index}"),
            IndicatorKind::Ema,
            [("period", json!(20)), ("source", json!("close"))],
        ));
        indicators.push(definition(
            format!("atr-{index}"),
            IndicatorKind::Atr,
            [("period", json!(14))],
        ));
        indicators.push(definition(
            format!("normalized-atr-{index}"),
            IndicatorKind::NormalizedAtr,
            [("period", json!(14))],
        ));
    }
    indicators.extend([
        definition(
            "donchian",
            IndicatorKind::DonchianChannel,
            [("period", json!(20))],
        ),
        definition(
            "fifty-two-week-position",
            IndicatorKind::FiftyTwoWeekHighLowPosition,
            [("period", json!(20))],
        ),
        definition(
            "williams-r",
            IndicatorKind::WilliamsR,
            [("period", json!(20))],
        ),
        definition(
            "choppiness",
            IndicatorKind::ChoppinessIndex,
            [("period", json!(20))],
        ),
        definition(
            "bollinger",
            IndicatorKind::BollingerBands,
            [
                ("period", json!(20)),
                ("source", json!("close")),
                ("stddev_multiplier", json!(2.0)),
            ],
        ),
        definition(
            "bollinger-width",
            IndicatorKind::BollingerBandWidthPercentB,
            [
                ("period", json!(20)),
                ("source", json!("close")),
                ("stddev_multiplier", json!(2.0)),
            ],
        ),
    ]);
    Ok(TechnicalAnalysisRequest {
        schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION.into(),
        response_mode: ResponseMode::LatestSummary,
        adjustment_policy: AdjustmentPolicy::Adjusted,
        instruments: vec![InstrumentSeries {
            key: "benchmark".into(),
            symbol: "BENCH".into(),
            market: "BENCHMARK".into(),
            currency: "USD".into(),
            instrument_type: InstrumentType::Etf,
            bars,
        }],
        indicators,
    })
}

fn digest(result: &impl Serialize) -> Result<String> {
    let payload = serde_json::to_vec(result)?;
    Ok(hex::encode(Sha256::digest(payload)))
}

fn distribution(samples: &[Duration]) -> Distribution {
    let mut milliseconds = samples
        .iter()
        .map(|sample| sample.as_secs_f64() * 1_000.0)
        .collect::<Vec<_>>();
    milliseconds.sort_by(f64::total_cmp);
    let percentile = |ratio: f64| {
        let index = ((milliseconds.len() as f64 * ratio).ceil() as usize)
            .saturating_sub(1)
            .min(milliseconds.len() - 1);
        milliseconds[index]
    };
    let p50_ms = percentile(0.50);
    let p95_ms = percentile(0.95);
    Distribution {
        samples_ms: milliseconds,
        p50_ms,
        p95_ms,
    }
}

fn improvement(baseline: f64, candidate: f64) -> f64 {
    (baseline - candidate) / baseline * 100.0
}

fn main() -> Result<()> {
    let bar_count = environment_usize("INDICATOR_BENCH_BARS", DEFAULT_BAR_COUNT)?;
    let iterations = environment_usize("INDICATOR_BENCH_ITERATIONS", DEFAULT_ITERATIONS)?;
    let request = request(bar_count)?;

    clear_indicator_cache();
    let mut uncached_samples = Vec::with_capacity(iterations);
    let mut expected_digest = None;
    for _ in 0..iterations {
        let started = Instant::now();
        let result = without_indicator_cache(|| analyze(&request, None))?;
        uncached_samples.push(started.elapsed());
        let current_digest = digest(&result)?;
        if let Some(expected) = &expected_digest {
            ensure!(
                expected == &current_digest,
                "uncached result digest changed"
            );
        } else {
            expected_digest = Some(current_digest);
        }
    }

    clear_indicator_cache();
    let warm = analyze(&request, None)?;
    ensure!(
        expected_digest.as_deref() == Some(digest(&warm)?.as_str()),
        "cached warm-up result differs from uncached result"
    );
    let mut cached_samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let result = analyze(&request, None)?;
        cached_samples.push(started.elapsed());
        ensure!(
            expected_digest.as_deref() == Some(digest(&result)?.as_str()),
            "cached result digest differs from uncached result"
        );
    }

    let uncached = distribution(&uncached_samples);
    let cached = distribution(&cached_samples);
    let p50_improvement_percent = improvement(uncached.p50_ms, cached.p50_ms);
    let p95_improvement_percent = improvement(uncached.p95_ms, cached.p95_ms);
    let passed = p50_improvement_percent >= MINIMUM_IMPROVEMENT_PERCENT
        && p95_improvement_percent >= MINIMUM_IMPROVEMENT_PERCENT;
    let report = BenchmarkReport {
        schema_version: "rust-indicator-cache-benchmark/v1",
        generated_at: format!(
            "{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .context("system clock precedes Unix epoch")?
                .as_secs()
        ),
        bar_count,
        indicator_count: request.indicators.len(),
        iterations,
        result_sha256: expected_digest.expect("at least one iteration"),
        uncached,
        cached,
        p50_improvement_percent,
        p95_improvement_percent,
        cache: indicator_cache_stats(),
        minimum_improvement_percent: MINIMUM_IMPROVEMENT_PERCENT,
        passed,
    };
    let output = std::env::var("INDICATOR_BENCH_OUTPUT")
        .unwrap_or_else(|_| ".cache/performance/rust-indicator-cache.json".into());
    let output_path = PathBuf::from(output);
    if let Some(parent) = output_path.parent() {
        create_dir_all(parent)?;
    }
    let payload = serde_json::to_vec_pretty(&report)?;
    write(&output_path, [&payload[..], b"\n"].concat())?;
    println!("{}", String::from_utf8(payload)?);
    ensure!(
        passed,
        "indicator cache p50/p95 improvement must both be at least {MINIMUM_IMPROVEMENT_PERCENT}%"
    );
    Ok(())
}
