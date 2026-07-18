use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    date::days_between,
    model::{AssetDefinition, TradeEvent},
    stats::{
        average, compounded_return, correlation, covariance, percentile_nearest_rank, round,
        sample_std,
    },
};

const TRADING_DAYS_PER_YEAR: f64 = 252.0;
const QUANTITY_EPSILON: f64 = 0.000_000_1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceCoverage {
    pub observations: usize,
    pub aligned_days: usize,
    pub first_date: String,
    pub last_date: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BenchmarkAnalyticsInput {
    pub key: String,
    pub name: String,
    pub returns: Vec<f64>,
    pub observations: usize,
}

pub struct AdvancedAnalyticsInput<'a> {
    pub assets: &'a [AssetDefinition],
    pub base_date: &'a str,
    pub effective_end_date: &'a str,
    pub requested_start_date: &'a str,
    pub returns: &'a [(String, f64)],
    pub asset_returns: &'a [Vec<f64>],
    pub benchmark: Option<BenchmarkAnalyticsInput>,
    pub average_weights: &'a [f64],
    pub ending_weights: &'a [f64],
    pub trades: &'a [TradeEvent],
    pub balances: &'a [(String, f64)],
    pub transaction_cost_bps: f64,
    pub risk_free_rate_percent: f64,
    pub gross_return_percent: f64,
    pub actual_total_cost: f64,
    pub cash_weight: f64,
    pub price_coverage: &'a [PriceCoverage],
}

fn month_key(date: &str) -> &str {
    date.get(..7).unwrap_or(date)
}

fn rolling_return(values: &[f64], end_index: usize, window: usize) -> Option<f64> {
    (end_index + 1 >= window)
        .then(|| compounded_return(&values[end_index + 1 - window..=end_index]))
        .flatten()
}

fn longest_streak(values: &[f64], predicate: impl Fn(f64) -> bool) -> usize {
    let mut current = 0;
    let mut maximum = 0;
    for &value in values {
        if predicate(value) {
            current += 1;
        } else {
            current = 0;
        }
        maximum = maximum.max(current);
    }
    maximum
}

fn monthly_returns(returns: &[(String, f64)]) -> Value {
    let mut by_month = BTreeMap::<String, Vec<f64>>::new();
    for (date, value) in returns {
        by_month
            .entry(month_key(date).to_owned())
            .or_default()
            .push(*value);
    }
    Value::Array(
        by_month
            .into_iter()
            .map(|(month, values)| {
                json!({
                    "month": month,
                    "returnPercent": round(compounded_return(&values).unwrap_or(0.0) * 100.0, 4),
                })
            })
            .collect(),
    )
}

fn relative_max_drawdown(portfolio: &[f64], benchmark: &[f64]) -> Option<f64> {
    if portfolio.is_empty() || portfolio.len() != benchmark.len() {
        return None;
    }
    let mut value: f64 = 1.0;
    let mut peak: f64 = 1.0;
    let mut maximum: f64 = 0.0;
    for (&portfolio_return, &benchmark_return) in portfolio.iter().zip(benchmark) {
        if benchmark_return <= -1.0 {
            continue;
        }
        value *= (1.0 + portfolio_return) / (1.0 + benchmark_return);
        peak = peak.max(value);
        maximum = maximum.min(value / peak - 1.0);
    }
    Some(round(maximum * 100.0, 4))
}

fn benchmark_comparison(
    benchmark: &BenchmarkAnalyticsInput,
    portfolio: &[f64],
    dates: &[String],
    risk_free_rate_percent: f64,
) -> Value {
    let length = portfolio.len().min(benchmark.returns.len());
    let portfolio = &portfolio[..length];
    let benchmark_returns = &benchmark.returns[..length];
    let active = portfolio
        .iter()
        .zip(benchmark_returns)
        .map(|(portfolio, benchmark)| portfolio - benchmark)
        .collect::<Vec<_>>();
    let tracking_error = sample_std(&active);
    let benchmark_variance = sample_std(benchmark_returns).powi(2);
    let beta = (benchmark_variance > 0.0)
        .then(|| covariance(portfolio, benchmark_returns) / benchmark_variance);
    let daily_risk_free =
        (1.0 + risk_free_rate_percent / 100.0).powf(1.0 / TRADING_DAYS_PER_YEAR) - 1.0;
    let alpha = beta.map(|beta| {
        ((average(portfolio) - daily_risk_free)
            - beta * (average(benchmark_returns) - daily_risk_free))
            * TRADING_DAYS_PER_YEAR
    });

    let upside = portfolio
        .iter()
        .zip(benchmark_returns)
        .filter(|(_, benchmark)| **benchmark > 0.0)
        .map(|(portfolio, benchmark)| (*portfolio, *benchmark))
        .collect::<Vec<_>>();
    let downside = portfolio
        .iter()
        .zip(benchmark_returns)
        .filter(|(_, benchmark)| **benchmark < 0.0)
        .map(|(portfolio, benchmark)| (*portfolio, *benchmark))
        .collect::<Vec<_>>();
    let capture = |values: &[(f64, f64)]| -> Option<f64> {
        let benchmark_mean = average(
            &values
                .iter()
                .map(|(_, benchmark)| *benchmark)
                .collect::<Vec<_>>(),
        );
        (!values.is_empty() && benchmark_mean != 0.0).then(|| {
            round(
                average(
                    &values
                        .iter()
                        .map(|(portfolio, _)| *portfolio)
                        .collect::<Vec<_>>(),
                ) / benchmark_mean
                    * 100.0,
                4,
            )
        })
    };

    let mut months = BTreeMap::<String, Vec<usize>>::new();
    for (index, date) in dates.iter().take(length).enumerate() {
        months
            .entry(month_key(date).to_owned())
            .or_default()
            .push(index);
    }
    let monthly_wins = months
        .values()
        .filter(|indices| {
            compounded_return(
                &indices
                    .iter()
                    .map(|&index| portfolio[index])
                    .collect::<Vec<_>>(),
            )
            .unwrap_or(0.0)
                > compounded_return(
                    &indices
                        .iter()
                        .map(|&index| benchmark_returns[index])
                        .collect::<Vec<_>>(),
                )
                .unwrap_or(0.0)
        })
        .count();
    let portfolio_return = compounded_return(portfolio);
    let benchmark_return = compounded_return(benchmark_returns);

    json!({
        "key": benchmark.key,
        "name": benchmark.name,
        "observations": length,
        "returnPercent": benchmark_return.map(|value| round(value * 100.0, 4)),
        "excessReturnPercent": portfolio_return.zip(benchmark_return)
            .map(|(portfolio, benchmark)| round((portfolio - benchmark) * 100.0, 4)),
        "trackingErrorPercent": (length > 1)
            .then(|| round(tracking_error * TRADING_DAYS_PER_YEAR.sqrt() * 100.0, 4)),
        "informationRatio": (tracking_error > 0.0)
            .then(|| round(average(&active) / tracking_error * TRADING_DAYS_PER_YEAR.sqrt(), 4)),
        "beta": beta.map(|value| round(value, 4)),
        "alphaPercent": alpha.map(|value| round(value * 100.0, 4)),
        "correlation": correlation(portfolio, benchmark_returns),
        "upsideCapturePercent": capture(&upside),
        "downsideCapturePercent": capture(&downside),
        "dailyWinRatePercent": (!portfolio.is_empty()).then(|| {
            round(
                portfolio.iter().zip(benchmark_returns)
                    .filter(|(portfolio, benchmark)| portfolio > benchmark)
                    .count() as f64 / portfolio.len() as f64 * 100.0,
                4,
            )
        }),
        "monthlyWinRatePercent": (!months.is_empty())
            .then(|| round(monthly_wins as f64 / months.len() as f64 * 100.0, 4)),
        "relativeMaxDrawdownPercent": relative_max_drawdown(portfolio, benchmark_returns),
    })
}

fn rolling_analytics(
    returns: &[(String, f64)],
    benchmark_returns: Option<&[f64]>,
    risk_free_rate_percent: f64,
) -> Value {
    let values = returns.iter().map(|(_, value)| *value).collect::<Vec<_>>();
    let daily_risk_free =
        (1.0 + risk_free_rate_percent / 100.0).powf(1.0 / TRADING_DAYS_PER_YEAR) - 1.0;
    Value::Array(
        returns
            .iter()
            .enumerate()
            .map(|(index, (date, _))| {
                let sixty = (index + 1 >= 60).then(|| &values[index - 59..=index]);
                let benchmark_sixty = benchmark_returns.and_then(|benchmark| {
                    (index + 1 >= 60 && index < benchmark.len())
                        .then(|| &benchmark[index - 59..=index])
                });
                let volatility = sixty.map(sample_std).unwrap_or(0.0);
                let benchmark_variance = benchmark_sixty.map(sample_std).unwrap_or(0.0).powi(2);
                let portfolio_sixty_return = sixty.and_then(compounded_return);
                let benchmark_sixty_return = benchmark_sixty.and_then(compounded_return);
                json!({
                    "date": date,
                    "return20d": rolling_return(&values, index, 20).map(|value| round(value * 100.0, 4)),
                    "return60d": rolling_return(&values, index, 60).map(|value| round(value * 100.0, 4)),
                    "return120d": rolling_return(&values, index, 120).map(|value| round(value * 100.0, 4)),
                    "return252d": rolling_return(&values, index, 252).map(|value| round(value * 100.0, 4)),
                    "volatility60d": sixty.map(|_| {
                        round(volatility * TRADING_DAYS_PER_YEAR.sqrt() * 100.0, 4)
                    }),
                    "sharpe60d": sixty.and_then(|window| (volatility > 0.0).then(|| {
                        round(
                            (average(window) - daily_risk_free) / volatility
                                * TRADING_DAYS_PER_YEAR.sqrt(),
                            4,
                        )
                    })),
                    "benchmarkExcess60d": portfolio_sixty_return.zip(benchmark_sixty_return)
                        .map(|(portfolio, benchmark)| round((portfolio - benchmark) * 100.0, 4)),
                    "benchmarkBeta60d": sixty.zip(benchmark_sixty).and_then(|(portfolio, benchmark)| {
                        (benchmark_variance > 0.0)
                            .then(|| round(covariance(portfolio, benchmark) / benchmark_variance, 4))
                    }),
                    "benchmarkCorrelation60d": sixty.zip(benchmark_sixty)
                        .and_then(|(portfolio, benchmark)| correlation(portfolio, benchmark)),
                })
            })
            .collect(),
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DrawdownEpisode {
    start_date: String,
    trough_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_date: Option<String>,
    depth_percent: f64,
    duration_days: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_days: Option<i64>,
}

fn drawdown_analytics(returns: &[(String, f64)], base_date: &str) -> Value {
    let mut value: f64 = 1.0;
    let mut peak: f64 = 1.0;
    let mut peak_date = base_date.to_owned();
    let mut current: Option<DrawdownEpisode> = None;
    let mut points = vec![json!({ "date": base_date, "drawdownPercent": 0.0 })];
    let mut episodes = Vec::<DrawdownEpisode>::new();

    for (date, item_return) in returns {
        value *= 1.0 + item_return;
        if value >= peak {
            if let Some(mut episode) = current.take() {
                episode.recovery_date = Some(date.clone());
                episode.duration_days = days_between(&episode.start_date, date);
                episode.recovery_days = Some(days_between(&episode.trough_date, date));
                episodes.push(episode);
            }
            peak = value;
            peak_date.clone_from(date);
        } else {
            let drawdown = value / peak - 1.0;
            match current.as_mut() {
                None => {
                    current = Some(DrawdownEpisode {
                        start_date: peak_date.clone(),
                        trough_date: date.clone(),
                        recovery_date: None,
                        depth_percent: round(drawdown * 100.0, 4),
                        duration_days: days_between(&peak_date, date),
                        recovery_days: None,
                    });
                }
                Some(episode) => {
                    episode.duration_days = days_between(&episode.start_date, date);
                    if drawdown < episode.depth_percent / 100.0 {
                        episode.depth_percent = round(drawdown * 100.0, 4);
                        episode.trough_date.clone_from(date);
                    }
                }
            }
        }
        points.push(json!({
            "date": date,
            "drawdownPercent": round((value / peak - 1.0) * 100.0, 4),
        }));
    }

    let current_underwater_days = current
        .as_ref()
        .map(|episode| {
            days_between(
                &episode.start_date,
                returns
                    .last()
                    .map(|(date, _)| date.as_str())
                    .unwrap_or(base_date),
            )
        })
        .unwrap_or(0);
    if let Some(episode) = current {
        episodes.push(episode);
    }
    episodes.sort_by(|left, right| left.depth_percent.total_cmp(&right.depth_percent));
    episodes.truncate(5);

    let negative = points
        .iter()
        .filter_map(|point| point["drawdownPercent"].as_f64())
        .filter(|value| *value < 0.0)
        .collect::<Vec<_>>();
    let values = returns.iter().map(|(_, value)| *value).collect::<Vec<_>>();
    let worst_window = |window: usize| -> Option<f64> {
        let candidates = values
            .iter()
            .enumerate()
            .filter_map(|(index, _)| rolling_return(&values, index, window))
            .collect::<Vec<_>>();
        (!candidates.is_empty()).then(|| {
            round(
                candidates.iter().copied().fold(f64::INFINITY, f64::min) * 100.0,
                4,
            )
        })
    };

    json!({
        "points": points,
        "episodes": episodes,
        "currentUnderwaterDays": current_underwater_days,
        "averageDrawdownPercent": (!negative.is_empty()).then(|| round(average(&negative), 4)),
        "ulcerIndex": (!negative.is_empty()).then(|| {
            round(average(&negative.iter().map(|value| value.powi(2)).collect::<Vec<_>>()).sqrt(), 4)
        }),
        "worst20DayReturnPercent": worst_window(20),
        "worst60DayReturnPercent": worst_window(60),
    })
}

fn tail_risk_analytics(returns: &[f64]) -> Value {
    let gains = returns
        .iter()
        .copied()
        .filter(|value| *value > 0.0)
        .collect::<Vec<_>>();
    let losses = returns
        .iter()
        .copied()
        .filter(|value| *value < 0.0)
        .collect::<Vec<_>>();
    let value_at_risk = percentile_nearest_rank(returns, 0.05);
    let tail = value_at_risk
        .map(|threshold| {
            returns
                .iter()
                .copied()
                .filter(|value| *value <= threshold)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mean = average(returns);
    let deviation = sample_std(returns);
    let average_gain = (!gains.is_empty()).then(|| average(&gains));
    let average_loss = (!losses.is_empty()).then(|| average(&losses));

    json!({
        "historicalVar95Percent": value_at_risk.map(|value| round(value * 100.0, 4)),
        "expectedShortfall95Percent": (!tail.is_empty()).then(|| round(average(&tail) * 100.0, 4)),
        "lossDaysPercent": (!returns.is_empty())
            .then(|| round(losses.len() as f64 / returns.len() as f64 * 100.0, 4)),
        "averageGainPercent": average_gain.map(|value| round(value * 100.0, 4)),
        "averageLossPercent": average_loss.map(|value| round(value * 100.0, 4)),
        "gainLossRatio": average_gain.zip(average_loss)
            .and_then(|(gain, loss)| (loss != 0.0).then(|| round(gain / loss.abs(), 4))),
        "skewness": (returns.len() >= 3 && deviation > 0.0).then(|| {
            round(
                average(&returns.iter()
                    .map(|value| ((value - mean) / deviation).powi(3))
                    .collect::<Vec<_>>()),
                4,
            )
        }),
        "excessKurtosis": (returns.len() >= 4 && deviation > 0.0).then(|| {
            round(
                average(&returns.iter()
                    .map(|value| ((value - mean) / deviation).powi(4))
                    .collect::<Vec<_>>()) - 3.0,
                4,
            )
        }),
        "maxConsecutiveGainDays": longest_streak(returns, |value| value > 0.0),
        "maxConsecutiveLossDays": longest_streak(returns, |value| value < 0.0),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RiskContribution {
    key: String,
    symbol: String,
    name: String,
    average_weight_percent: f64,
    ending_weight_percent: f64,
    annualized_volatility_percent: Option<f64>,
    risk_contribution_percent: Option<f64>,
    correlation_to_portfolio: Option<f64>,
}

fn risk_analytics(
    assets: &[AssetDefinition],
    asset_returns: &[Vec<f64>],
    portfolio_returns: &[f64],
    average_weights: &[f64],
    ending_weights: &[f64],
    cash_weight: f64,
) -> (Value, Value) {
    let series = |index: usize| asset_returns.get(index).map(Vec::as_slice).unwrap_or(&[]);
    let average_weight = |index: usize| average_weights.get(index).copied().unwrap_or(0.0);
    let ending_weight = |index: usize| ending_weights.get(index).copied().unwrap_or(0.0);

    let mut portfolio_variance = 0.0;
    for left in 0..assets.len() {
        for right in 0..assets.len() {
            portfolio_variance += average_weight(left)
                * average_weight(right)
                * covariance(series(left), series(right));
        }
    }

    let mut risk_contributions = assets
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            let marginal_variance = (0..assets.len())
                .map(|other| average_weight(other) * covariance(series(index), series(other)))
                .sum::<f64>();
            let volatility = sample_std(series(index));
            RiskContribution {
                key: format!("{}:{}", asset.currency, asset.symbol),
                symbol: asset.symbol.clone(),
                name: asset.name.clone(),
                average_weight_percent: round(average_weight(index) * 100.0, 4),
                ending_weight_percent: round(ending_weight(index) * 100.0, 4),
                annualized_volatility_percent: (series(index).len() > 1)
                    .then(|| round(volatility * TRADING_DAYS_PER_YEAR.sqrt() * 100.0, 4)),
                risk_contribution_percent: (portfolio_variance > 0.0).then(|| {
                    round(
                        average_weight(index) * marginal_variance / portfolio_variance * 100.0,
                        4,
                    )
                }),
                correlation_to_portfolio: correlation(series(index), portfolio_returns),
            }
        })
        .collect::<Vec<_>>();
    risk_contributions.sort_by(|left, right| {
        right
            .risk_contribution_percent
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&left.risk_contribution_percent.unwrap_or(f64::NEG_INFINITY))
    });

    // Cash is denominated in the KRW reporting currency. Including it here prevents
    // the legacy `1 - KRW weight` shortcut from incorrectly reporting cash as USD.
    let cash_weight = cash_weight.clamp(0.0, 1.0);
    let krw_asset_weight = assets
        .iter()
        .enumerate()
        .filter(|(_, asset)| asset.currency == "KRW")
        .map(|(index, _)| ending_weight(index))
        .sum::<f64>();
    let usd_weight = assets
        .iter()
        .enumerate()
        .filter(|(_, asset)| asset.currency != "KRW")
        .map(|(index, _)| ending_weight(index))
        .sum::<f64>();
    let krw_weight = krw_asset_weight + cash_weight;
    let mut sorted_weights = (0..assets.len()).map(ending_weight).collect::<Vec<_>>();
    if cash_weight > 0.0 {
        sorted_weights.push(cash_weight);
    }
    sorted_weights.sort_by(|left, right| right.total_cmp(left));
    let sum_top = |count: usize| {
        round(
            sorted_weights.iter().take(count).copied().sum::<f64>() * 100.0,
            4,
        )
    };
    let hhi = sorted_weights
        .iter()
        .map(|weight| weight.powi(2))
        .sum::<f64>();
    let weighted_individual_volatility = assets
        .iter()
        .enumerate()
        .map(|(index, _)| average_weight(index) * sample_std(series(index)))
        .sum::<f64>();
    let portfolio_volatility = portfolio_variance.max(0.0).sqrt();
    let exposure = json!({
        "krwWeightPercent": round(krw_weight * 100.0, 4),
        "usdWeightPercent": round(usd_weight * 100.0, 4),
        "domesticWeightPercent": round(krw_weight * 100.0, 4),
        "overseasWeightPercent": round(usd_weight * 100.0, 4),
        "top1WeightPercent": sum_top(1),
        "top5WeightPercent": sum_top(5),
        "top10WeightPercent": sum_top(10),
        "hhi": round(hhi, 6),
        "effectivePositions": (hhi > 0.0).then(|| round(1.0 / hhi, 2)),
        "diversificationBenefitPercent": (weighted_individual_volatility > 0.0
            && portfolio_variance > 0.0)
            .then(|| round((1.0 - portfolio_volatility / weighted_individual_volatility) * 100.0, 4)),
    });

    (json!(risk_contributions), exposure)
}

fn cost_analytics(
    trades: &[TradeEvent],
    balances: &[(String, f64)],
    transaction_cost_bps: f64,
    gross_return_percent: f64,
    actual_total_cost: f64,
    net_return_percent: Option<f64>,
) -> Value {
    let total_traded_amount = trades.iter().map(|trade| trade.amount).sum::<f64>();
    let ongoing_traded_amount = trades
        .iter()
        .filter(|trade| trade.reason != "initial")
        .map(|trade| trade.amount)
        .sum::<f64>();
    let total_buy_amount = trades
        .iter()
        .filter(|trade| trade.side == "BUY")
        .map(|trade| trade.amount)
        .sum::<f64>();
    let total_sell_amount = trades
        .iter()
        .filter(|trade| trade.side == "SELL")
        .map(|trade| trade.amount)
        .sum::<f64>();
    let average_value = average(&balances.iter().map(|(_, value)| *value).collect::<Vec<_>>());
    let estimated_total_cost = total_traded_amount * transaction_cost_bps / 10_000.0;
    let cost_drag_percent =
        (average_value > 0.0).then(|| actual_total_cost / average_value * 100.0);
    let path_return_percent = net_return_percent.unwrap_or(gross_return_percent);
    let estimated_gross_return_percent = cost_drag_percent.map(|value| path_return_percent + value);

    let mut values_by_month = BTreeMap::<String, Vec<f64>>::new();
    for (date, value) in balances {
        values_by_month
            .entry(month_key(date).to_owned())
            .or_default()
            .push(*value);
    }
    let mut trades_by_month = BTreeMap::<String, Vec<&TradeEvent>>::new();
    for trade in trades {
        trades_by_month
            .entry(month_key(&trade.date).to_owned())
            .or_default()
            .push(trade);
    }
    let months = values_by_month
        .keys()
        .chain(trades_by_month.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let monthly = months
        .into_iter()
        .map(|month| {
            let month_trades = trades_by_month
                .get(&month)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let traded_amount = month_trades.iter().map(|trade| trade.amount).sum::<f64>();
            let average_month_value = values_by_month
                .get(&month)
                .map(|values| average(values))
                .unwrap_or(0.0);
            json!({
                "month": month,
                "turnoverPercent": if average_month_value > 0.0 {
                    round(traded_amount / (2.0 * average_month_value) * 100.0, 4)
                } else {
                    0.0
                },
                "tradeCount": month_trades.len(),
                "tradedAmount": round(traded_amount, 2),
                "estimatedCost": round(traded_amount * transaction_cost_bps / 10_000.0, 2),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "transactionCostBps": round(transaction_cost_bps, 2),
        "turnoverPercent": (average_value > 0.0)
            .then(|| round(ongoing_traded_amount / (2.0 * average_value) * 100.0, 4)),
        "totalTradedAmount": round(total_traded_amount, 2),
        "ongoingTradedAmount": round(ongoing_traded_amount, 2),
        "estimatedTotalCost": round(estimated_total_cost, 2),
        "actualTotalCost": round(actual_total_cost, 2),
        "costsDeductedFromPath": true,
        "costDragPercent": cost_drag_percent.map(|value| round(value, 4)),
        "grossReturnPercent": estimated_gross_return_percent.map(|value| round(value, 4)),
        "netEstimatedReturnPercent": round(path_return_percent, 4),
        "netReturnPercent": round(path_return_percent, 4),
        "method": "actual_path_deduction",
        "averageTradeAmount": (!trades.is_empty())
            .then(|| round(total_traded_amount / trades.len() as f64, 2)),
        "buySellAmountRatio": (total_sell_amount > 0.0)
            .then(|| round(total_buy_amount / total_sell_amount, 4)),
        "tradeCount": trades.len(),
        "monthly": monthly,
    })
}

#[derive(Debug)]
struct Lot {
    quantity: f64,
    unit_cost: f64,
    date: String,
}

#[derive(Debug)]
struct RealizedLot {
    profit_loss: f64,
    quantity: f64,
    holding_days: f64,
}

fn trade_behavior_analytics(trades: &[TradeEvent]) -> Value {
    let mut lots = BTreeMap::<usize, VecDeque<Lot>>::new();
    let mut realized = Vec::<RealizedLot>::new();
    let mut matched_sell_count = 0;
    let mut unmatched_sell_count = 0;

    for trade in trades {
        let asset_lots = lots.entry(trade.asset_index).or_default();
        if trade.side == "BUY" {
            if trade.quantity > 0.0 {
                asset_lots.push_back(Lot {
                    quantity: trade.quantity,
                    unit_cost: trade.amount / trade.quantity,
                    date: trade.date.clone(),
                });
            }
            continue;
        }

        let mut remaining = trade.quantity;
        let mut matched_quantity = 0.0;
        let mut cost_basis = 0.0;
        let mut weighted_holding_days = 0.0;
        while remaining > QUANTITY_EPSILON && !asset_lots.is_empty() {
            let lot = asset_lots.front_mut().expect("lot checked above");
            let quantity = remaining.min(lot.quantity);
            matched_quantity += quantity;
            cost_basis += quantity * lot.unit_cost;
            weighted_holding_days += quantity * days_between(&lot.date, &trade.date) as f64;
            remaining -= quantity;
            lot.quantity -= quantity;
            if lot.quantity <= QUANTITY_EPSILON {
                asset_lots.pop_front();
            }
        }
        if matched_quantity <= 0.0 || remaining > QUANTITY_EPSILON {
            unmatched_sell_count += 1;
            continue;
        }
        realized.push(RealizedLot {
            profit_loss: trade.amount * (matched_quantity / trade.quantity) - cost_basis,
            quantity: matched_quantity,
            holding_days: weighted_holding_days / matched_quantity,
        });
        matched_sell_count += 1;
    }

    let profits = realized
        .iter()
        .filter(|item| item.profit_loss > 0.0)
        .map(|item| item.profit_loss)
        .sum::<f64>();
    let losses = realized
        .iter()
        .filter(|item| item.profit_loss < 0.0)
        .map(|item| item.profit_loss)
        .sum::<f64>();
    let total_quantity = realized.iter().map(|item| item.quantity).sum::<f64>();

    json!({
        "estimatedRealizedProfitLoss": round(realized.iter().map(|item| item.profit_loss).sum(), 2),
        "estimatedWinRatePercent": (!realized.is_empty()).then(|| {
            round(
                realized.iter().filter(|item| item.profit_loss > 0.0).count() as f64
                    / realized.len() as f64 * 100.0,
                4,
            )
        }),
        "estimatedProfitFactor": (losses < 0.0).then(|| round(profits / losses.abs(), 4)),
        "estimatedAverageHoldingDays": (total_quantity > 0.0).then(|| {
            round(
                realized.iter().map(|item| item.holding_days * item.quantity).sum::<f64>()
                    / total_quantity,
                1,
            )
        }),
        "matchedSellCount": matched_sell_count,
        "unmatchedSellCount": unmatched_sell_count,
        "buyCount": trades.iter().filter(|trade| trade.side == "BUY").count(),
        "sellCount": trades.iter().filter(|trade| trade.side == "SELL").count(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetQuality {
    key: String,
    symbol: String,
    name: String,
    observations: usize,
    aligned_days: usize,
    coverage_percent: f64,
    first_date: String,
    last_date: String,
}

pub fn calculate(input: AdvancedAnalyticsInput<'_>) -> Value {
    let return_values = input
        .returns
        .iter()
        .map(|(_, value)| *value)
        .collect::<Vec<_>>();
    let return_dates = input
        .returns
        .iter()
        .map(|(date, _)| date.clone())
        .collect::<Vec<_>>();
    let (risk_contributions, exposure) = risk_analytics(
        input.assets,
        input.asset_returns,
        &return_values,
        input.average_weights,
        input.ending_weights,
        input.cash_weight,
    );

    let asset_quality = input
        .assets
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            let coverage = input.price_coverage.get(index);
            let observations = coverage.map(|value| value.observations).unwrap_or(0);
            let aligned_days = coverage.map(|value| value.aligned_days).unwrap_or(0);
            AssetQuality {
                key: format!("{}:{}", asset.currency, asset.symbol),
                symbol: asset.symbol.clone(),
                name: asset.name.clone(),
                observations,
                aligned_days,
                coverage_percent: if aligned_days > 0 {
                    round(observations as f64 / aligned_days as f64 * 100.0, 4)
                } else {
                    0.0
                },
                first_date: coverage
                    .map(|value| value.first_date.clone())
                    .unwrap_or_else(|| input.base_date.to_owned()),
                last_date: coverage
                    .map(|value| value.last_date.clone())
                    .unwrap_or_else(|| input.effective_end_date.to_owned()),
            }
        })
        .collect::<Vec<_>>();
    let carried_forward_observations = asset_quality
        .iter()
        .map(|item| item.aligned_days.saturating_sub(item.observations))
        .sum::<usize>();
    let common_coverage_percent = asset_quality
        .iter()
        .map(|item| item.coverage_percent)
        .min_by(f64::total_cmp)
        .unwrap_or(0.0);
    let confidence = if input.returns.len() >= 60 && common_coverage_percent >= 85.0 {
        "high"
    } else if input.returns.len() >= 20 && common_coverage_percent >= 65.0 {
        "medium"
    } else {
        "limited"
    };
    let mut notes = vec![
        "서로 다른 시장의 휴장일은 직전 수정주가를 이월해 공통 일자에 정렬했습니다.".to_owned(),
        "해외 종목은 날짜별 과거 환율을 반영한 KRW 수정주가 수익률을 사용합니다.".to_owned(),
    ];
    if input.base_date > input.requested_start_date {
        notes.insert(
            0,
            format!("공통 일봉이 시작되는 {}부터 계산했습니다.", input.base_date),
        );
    }

    let net_return_percent = compounded_return(&return_values).map(|value| value * 100.0);
    let mut output = Map::new();
    if let Some(benchmark) = input.benchmark.as_ref() {
        output.insert(
            "benchmarkComparison".to_owned(),
            benchmark_comparison(
                benchmark,
                &return_values,
                &return_dates,
                input.risk_free_rate_percent,
            ),
        );
    }
    output.insert(
        "rolling".to_owned(),
        rolling_analytics(
            input.returns,
            input
                .benchmark
                .as_ref()
                .map(|value| value.returns.as_slice()),
            input.risk_free_rate_percent,
        ),
    );
    output.insert(
        "drawdowns".to_owned(),
        drawdown_analytics(input.returns, input.base_date),
    );
    output.insert("tailRisk".to_owned(), tail_risk_analytics(&return_values));
    output.insert("monthlyReturns".to_owned(), monthly_returns(input.returns));
    output.insert("riskContributions".to_owned(), risk_contributions);
    output.insert("exposure".to_owned(), exposure);
    output.insert(
        "costEfficiency".to_owned(),
        cost_analytics(
            input.trades,
            input.balances,
            input.transaction_cost_bps,
            input.gross_return_percent,
            input.actual_total_cost,
            net_return_percent,
        ),
    );
    output.insert(
        "tradeBehavior".to_owned(),
        trade_behavior_analytics(input.trades),
    );
    output.insert(
        "dataQuality".to_owned(),
        json!({
            "confidence": confidence,
            "observationDays": input.returns.len() + 1,
            "returnObservationDays": input.returns.len(),
            "requestedCalendarDays": days_between(input.requested_start_date, input.effective_end_date) + 1,
            "effectiveStartDate": input.base_date,
            "effectiveEndDate": input.effective_end_date,
            "commonCoveragePercent": common_coverage_percent,
            "carriedForwardObservations": carried_forward_observations,
            "benchmarkObservations": input.benchmark.as_ref().map(|value| value.observations).unwrap_or(0),
            "assets": asset_quality,
            "notes": notes,
        }),
    );
    Value::Object(output)
}

#[cfg(test)]
mod tests {
    use approx::assert_abs_diff_eq;

    use super::*;

    fn asset(symbol: &str, currency: &str, weight: f64) -> AssetDefinition {
        AssetDefinition {
            symbol: symbol.to_owned(),
            name: format!("{symbol} name"),
            market: if currency == "KRW" { "KOSPI" } else { "NASDAQ" }.to_owned(),
            currency: currency.to_owned(),
            list_date: "2020-01-01".to_owned(),
            weight,
            lot_size: 1.0,
            delist_date: None,
            universe_member_from: None,
            universe_member_to: None,
        }
    }

    fn trade(
        asset_index: usize,
        date: &str,
        side: &str,
        amount: f64,
        quantity: f64,
        reason: &str,
        cost: f64,
    ) -> TradeEvent {
        TradeEvent {
            asset_index,
            date: date.to_owned(),
            symbol: if asset_index == 0 { "005930" } else { "AAPL" }.to_owned(),
            side: side.to_owned(),
            amount,
            quantity,
            price: amount / quantity,
            reason: reason.to_owned(),
            transaction_cost: cost,
            commission: cost,
            tax: 0.0,
            slippage_cost: 0.0,
            market_impact_cost: 0.0,
            participation_rate_percent: None,
            net_cash_impact: if side == "BUY" {
                -(amount + cost)
            } else {
                amount - cost
            },
            trigger: reason.to_owned(),
            lot_size: 1.0,
        }
    }

    #[test]
    fn produces_camel_case_analytics_with_actual_path_costs() {
        let assets = vec![asset("005930", "KRW", 50.0), asset("AAPL", "USD", 50.0)];
        let returns = vec![
            ("2026-01-02".to_owned(), 0.01),
            ("2026-01-05".to_owned(), -0.005),
            ("2026-01-06".to_owned(), 0.002),
        ];
        let asset_returns = vec![vec![0.02, -0.01, 0.004], vec![0.0, 0.0, 0.0]];
        let benchmark = BenchmarkAnalyticsInput {
            key: "SP500".to_owned(),
            name: "S&P 500".to_owned(),
            returns: vec![0.005, -0.002, 0.001],
            observations: 4,
        };
        let trades = vec![
            trade(0, "2026-01-01", "BUY", 400.0, 4.0, "initial", 1.0),
            trade(1, "2026-01-01", "BUY", 400.0, 4.0, "initial", 1.0),
            trade(0, "2026-01-06", "SELL", 110.0, 1.0, "rebalance", 0.5),
        ];
        let balances = vec![
            ("2026-01-01".to_owned(), 1_000.0),
            ("2026-01-06".to_owned(), 1_006.9),
        ];
        let coverage = vec![
            PriceCoverage {
                observations: 4,
                aligned_days: 4,
                first_date: "2026-01-01".to_owned(),
                last_date: "2026-01-06".to_owned(),
            },
            PriceCoverage {
                observations: 4,
                aligned_days: 4,
                first_date: "2026-01-01".to_owned(),
                last_date: "2026-01-06".to_owned(),
            },
        ];

        let result = calculate(AdvancedAnalyticsInput {
            assets: &assets,
            base_date: "2026-01-01",
            effective_end_date: "2026-01-06",
            requested_start_date: "2025-12-31",
            returns: &returns,
            asset_returns: &asset_returns,
            benchmark: Some(benchmark),
            average_weights: &[0.4, 0.4],
            ending_weights: &[0.4, 0.4],
            trades: &trades,
            balances: &balances,
            transaction_cost_bps: 15.0,
            risk_free_rate_percent: 2.0,
            gross_return_percent: 1.0,
            actual_total_cost: 2.5,
            cash_weight: 0.2,
            price_coverage: &coverage,
        });

        assert_eq!(result["benchmarkComparison"]["key"], "SP500");
        assert_eq!(result["costEfficiency"]["actualTotalCost"], 2.5);
        assert_eq!(result["costEfficiency"]["costsDeductedFromPath"], true);
        assert_eq!(result["costEfficiency"]["method"], "actual_path_deduction");
        assert_abs_diff_eq!(
            result["costEfficiency"]["netReturnPercent"]
                .as_f64()
                .unwrap(),
            0.696,
            epsilon = 0.000_1
        );
        assert_eq!(result["exposure"]["krwWeightPercent"], 60.0);
        assert_eq!(result["exposure"]["usdWeightPercent"], 40.0);
        assert_eq!(result["exposure"]["hhi"], 0.36);
        assert_eq!(result["tradeBehavior"]["matchedSellCount"], 1);
        assert_eq!(result["tradeBehavior"]["estimatedRealizedProfitLoss"], 10.0);
        assert!(
            result["dataQuality"]["notes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|note| note.as_str().unwrap().contains("과거 환율을 반영"))
        );
        assert!(
            result["dataQuality"]["notes"][0]
                .as_str()
                .unwrap()
                .contains("2026-01-01부터")
        );
    }

    #[test]
    fn handles_empty_series_without_non_finite_json_values() {
        let result = calculate(AdvancedAnalyticsInput {
            assets: &[],
            base_date: "2026-01-01",
            effective_end_date: "2026-01-01",
            requested_start_date: "2026-01-01",
            returns: &[],
            asset_returns: &[],
            benchmark: None,
            average_weights: &[],
            ending_weights: &[],
            trades: &[],
            balances: &[],
            transaction_cost_bps: 0.0,
            risk_free_rate_percent: 0.0,
            gross_return_percent: 0.0,
            actual_total_cost: 0.0,
            cash_weight: 0.0,
            price_coverage: &[],
        });

        assert!(result.get("benchmarkComparison").is_none());
        assert_eq!(result["rolling"], json!([]));
        assert_eq!(result["costEfficiency"]["netReturnPercent"], 0.0);
        assert_eq!(result["dataQuality"]["confidence"], "limited");
        serde_json::to_string(&result).unwrap();
    }
}
