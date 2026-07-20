use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail, ensure};

use crate::analytics::{AdvancedAnalyticsInput, BenchmarkAnalyticsInput, PriceCoverage};
use crate::control::{ComputeControl, checkpoint};
use crate::date::{days_between, year_month};
use crate::model::*;
use crate::stats::{average, correlation, round, sample_std, xirr};

const EPSILON: f64 = 1e-9;

#[derive(Clone)]
struct AlignedPoint {
    date: String,
    closes: Vec<f64>,
    local_closes: Vec<f64>,
    fx_rates: Vec<f64>,
    volumes: Vec<Option<f64>>,
    cash_dividends: Vec<f64>,
    observed: Vec<bool>,
    benchmark_close: Option<f64>,
}

type Alignment = (
    Vec<AlignedPoint>,
    Vec<Vec<PricePoint>>,
    Vec<PricePoint>,
    Vec<BTreeSet<String>>,
    BTreeSet<String>,
    Vec<usize>,
    usize,
);

impl AlignedPoint {
    fn common_observation(&self, input: &BacktestSimulationInput) -> bool {
        self.observed
            .iter()
            .enumerate()
            .all(|(index, observed)| !asset_active(input, index, &self.date) || *observed)
    }
}

#[derive(Default)]
struct Ledger {
    quantities: Vec<f64>,
    volumes: Vec<Option<f64>>,
    policy_target_weights: Vec<f64>,
    policy_cash_target_percent: f64,
    target_weights: Vec<f64>,
    cash_target_percent: f64,
    cash: f64,
    units: f64,
    total_costs: f64,
    total_dividend_income: f64,
    total_dividend_taxes: f64,
    liquidity_observations: usize,
    missing_liquidity_observations: usize,
    trades: Vec<TradeEvent>,
    dividends: Vec<DividendEvent>,
}

impl Ledger {
    fn invested(&self, prices: &[f64]) -> f64 {
        self.quantities
            .iter()
            .zip(prices)
            .map(|(quantity, price)| quantity * price)
            .sum()
    }

    fn balance(&self, prices: &[f64]) -> f64 {
        self.cash + self.invested(prices)
    }

    fn unit_price(&self, prices: &[f64]) -> f64 {
        if self.units > EPSILON {
            self.balance(prices) / self.units
        } else {
            0.0
        }
    }
}

fn key_for_asset(asset: &AssetDefinition) -> String {
    format!("{}:{}", asset.currency, asset.symbol)
}

fn clean_series(series: &[PricePoint], start: &str, end: &str) -> Vec<PricePoint> {
    let mut by_date = BTreeMap::new();
    for point in series {
        if point.date.as_str() >= start
            && point.date.as_str() <= end
            && point.close.is_finite()
            && point.close > 0.0
        {
            by_date.insert(point.date.clone(), point.clone());
        }
    }
    by_date.into_values().collect()
}

fn align(input: &BacktestSimulationInput) -> Result<Alignment> {
    let series_by_asset = input
        .assets
        .iter()
        .map(|asset| {
            let key = key_for_asset(asset);
            let series = clean_series(
                input.prices.get(&key).map(Vec::as_slice).unwrap_or(&[]),
                &input.requested_start_date,
                &input.end_date,
            );
            if series.is_empty() {
                bail!("{}의 선택 기간 일봉이 없습니다.", asset.name);
            }
            Ok(series)
        })
        .collect::<Result<Vec<_>>>()?;
    let observed_by_asset = input
        .assets
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            let key = key_for_asset(asset);
            input
                .observed_dates
                .get(&key)
                .map(|dates| dates.iter().cloned().collect::<BTreeSet<_>>())
                .unwrap_or_else(|| {
                    series_by_asset[index]
                        .iter()
                        .map(|point| point.date.clone())
                        .collect()
                })
        })
        .collect::<Vec<_>>();
    let benchmark_series = input
        .benchmark
        .as_ref()
        .map(|benchmark| {
            clean_series(
                &benchmark.prices,
                &input.requested_start_date,
                &input.end_date,
            )
        })
        .unwrap_or_default();
    let benchmark_observed = input
        .benchmark
        .as_ref()
        .map(|benchmark| {
            input
                .observed_dates
                .get(&benchmark.key)
                .map(|dates| dates.iter().cloned().collect::<BTreeSet<_>>())
                .unwrap_or_else(|| {
                    benchmark_series
                        .iter()
                        .map(|point| point.date.clone())
                        .collect()
                })
        })
        .unwrap_or_default();
    if let Some(benchmark) = &input.benchmark
        && benchmark_series.is_empty()
    {
        bail!("{}의 선택 기간 일봉이 없습니다.", benchmark.name);
    }

    let mut dates = BTreeSet::new();
    for series in &series_by_asset {
        dates.extend(series.iter().map(|point| point.date.clone()));
    }
    dates.extend(benchmark_series.iter().map(|point| point.date.clone()));

    let mut cursors = vec![0_usize; input.assets.len()];
    let mut current = vec![None::<PricePoint>; input.assets.len()];
    let mut last_observed = vec![String::new(); input.assets.len()];
    let mut carry_forward = vec![0_usize; input.assets.len()];
    let mut benchmark_cursor = 0_usize;
    let mut benchmark_current = None::<PricePoint>;
    let mut benchmark_last_observed = String::new();
    let mut benchmark_carry_forward = 0_usize;
    let mut aligned = Vec::new();

    for date in dates {
        for (index, series) in series_by_asset.iter().enumerate() {
            while cursors[index] < series.len() && series[cursors[index]].date <= date {
                current[index] = Some(series[cursors[index]].clone());
                if observed_by_asset[index].contains(&series[cursors[index]].date) {
                    last_observed[index] = series[cursors[index]].date.clone();
                }
                cursors[index] += 1;
            }
        }
        while benchmark_cursor < benchmark_series.len()
            && benchmark_series[benchmark_cursor].date <= date
        {
            benchmark_current = Some(benchmark_series[benchmark_cursor].clone());
            if benchmark_observed.contains(&benchmark_series[benchmark_cursor].date) {
                benchmark_last_observed = benchmark_series[benchmark_cursor].date.clone();
            }
            benchmark_cursor += 1;
        }
        if current
            .iter()
            .enumerate()
            .all(|(index, point)| point.is_some() || !asset_active(input, index, &date))
            && (input.benchmark.is_none() || benchmark_current.is_some())
        {
            let valuation_points = current
                .iter()
                .enumerate()
                .map(|(index, point)| point.as_ref().unwrap_or(&series_by_asset[index][0]))
                .collect::<Vec<_>>();
            let observed = last_observed
                .iter()
                .map(|value| value == &date)
                .collect::<Vec<_>>();
            for (index, is_observed) in observed.iter().enumerate() {
                if asset_active(input, index, &date) && !is_observed {
                    carry_forward[index] += 1;
                }
            }
            if input.benchmark.is_some() && benchmark_last_observed != date {
                benchmark_carry_forward += 1;
            }
            aligned.push(AlignedPoint {
                date: date.clone(),
                closes: valuation_points.iter().map(|point| point.close).collect(),
                local_closes: valuation_points
                    .iter()
                    .map(|point| point.local_close.unwrap_or(point.close))
                    .collect(),
                fx_rates: valuation_points
                    .iter()
                    .map(|point| point.fx_rate.unwrap_or(1.0))
                    .collect(),
                volumes: valuation_points
                    .iter()
                    .map(|point| (point.date == date).then_some(point.volume).flatten())
                    .collect(),
                cash_dividends: valuation_points
                    .iter()
                    .map(|point| {
                        if point.date == date {
                            point.cash_dividend.unwrap_or(0.0)
                        } else {
                            0.0
                        }
                    })
                    .collect(),
                observed,
                benchmark_close: benchmark_current.as_ref().map(|point| point.close),
            });
        }
    }
    let safe_start = aligned
        .iter()
        .position(|point| point.common_observation(input))
        .ok_or_else(|| anyhow::anyhow!("활성 거래 대상 종목의 공통 실제 관측일이 필요합니다."))?;
    aligned.drain(..safe_start);
    ensure!(
        aligned.len() >= 2,
        "모든 종목에 공통으로 존재하는 일봉이 2개 이상 필요합니다."
    );
    Ok((
        aligned,
        series_by_asset,
        benchmark_series,
        observed_by_asset,
        benchmark_observed,
        carry_forward,
        benchmark_carry_forward,
    ))
}

/// Returns the exact dates on which the ledger can execute a portfolio-wide
/// policy change. This deliberately reuses the ledger's alignment and
/// point-in-time-universe rules so upstream signal code cannot invent a
/// different definition of a safe trading day.
pub(crate) fn common_observation_dates(input: &BacktestSimulationInput) -> Result<Vec<String>> {
    validate(input)?;
    let (aligned, ..) = align(input)?;
    Ok(aligned
        .iter()
        .filter(|point| point.common_observation(input))
        .map(|point| point.date.clone())
        .collect())
}

fn cash_flow_due(
    previous_date: &str,
    current_date: &str,
    next_date: Option<&str>,
    frequency: CashFlowFrequency,
    timing: CashFlowTiming,
) -> bool {
    let month = current_date[5..7].parse::<u32>().unwrap_or(1);
    let interval = match frequency {
        CashFlowFrequency::Monthly => 1,
        CashFlowFrequency::Quarterly => 3,
        CashFlowFrequency::Annually => 12,
    };
    match timing {
        CashFlowTiming::PeriodStart => {
            year_month(previous_date) != year_month(current_date) && (month - 1) % interval == 0
        }
        CashFlowTiming::PeriodEnd => {
            let observed_end =
                next_date.is_none_or(|next| year_month(current_date) != year_month(next));
            observed_end && month % interval == 0
        }
    }
}

fn scheduled_rebalance(
    previous_date: &str,
    current_date: &str,
    frequency: RebalanceFrequency,
) -> bool {
    if matches!(
        frequency,
        RebalanceFrequency::None | RebalanceFrequency::Threshold
    ) {
        return false;
    }
    let previous_year = previous_date[..4].parse::<i32>().unwrap_or(0);
    let current_year = current_date[..4].parse::<i32>().unwrap_or(0);
    if frequency == RebalanceFrequency::Annually {
        return previous_year != current_year;
    }
    let previous_month = previous_date[5..7].parse::<i32>().unwrap_or(1);
    let current_month = current_date[5..7].parse::<i32>().unwrap_or(1);
    if frequency == RebalanceFrequency::Quarterly {
        return previous_year != current_year
            || (previous_month - 1) / 3 != (current_month - 1) / 3;
    }
    previous_year != current_year || previous_month != current_month
}

fn configured_target_weights(input: &BacktestSimulationInput) -> Vec<f64> {
    input
        .assets
        .iter()
        .map(|asset| asset.weight / 100.0)
        .collect()
}

fn asset_active(input: &BacktestSimulationInput, index: usize, date: &str) -> bool {
    if !input.realism.enforce_point_in_time_universe {
        return true;
    }
    let asset = &input.assets[index];
    asset
        .universe_member_from
        .as_ref()
        .is_some_and(|from| from.as_str() <= date)
        && asset
            .universe_member_to
            .as_ref()
            .is_some_and(|to| date < to.as_str())
        && asset
            .delist_date
            .as_ref()
            .is_none_or(|delist| date < delist.as_str())
}

fn effective_target_weights(
    input: &BacktestSimulationInput,
    policy_weights: &[f64],
    policy_cash_target_percent: f64,
    date: &str,
) -> (Vec<f64>, f64) {
    if !input.realism.enforce_point_in_time_universe {
        return (policy_weights.to_vec(), policy_cash_target_percent);
    }
    let active_total = policy_weights
        .iter()
        .enumerate()
        .filter(|(index, _)| asset_active(input, *index, date))
        .map(|(_, weight)| *weight)
        .sum::<f64>();
    if active_total <= EPSILON {
        return (vec![0.0; policy_weights.len()], 100.0);
    }
    let invested_target = (1.0 - policy_cash_target_percent / 100.0).max(0.0);
    (
        policy_weights
            .iter()
            .enumerate()
            .map(|(index, weight)| {
                if asset_active(input, index, date) {
                    weight / active_total * invested_target
                } else {
                    0.0
                }
            })
            .collect(),
        policy_cash_target_percent,
    )
}

fn scheduled_target_weights(
    input: &BacktestSimulationInput,
    entry: &TargetWeightScheduleEntry,
) -> Vec<f64> {
    input
        .assets
        .iter()
        .map(|asset| entry.weights.get(&asset.symbol).copied().unwrap_or(0.0) / 100.0)
        .collect()
}

fn validate(input: &BacktestSimulationInput) -> Result<()> {
    ensure!(
        (1..=20).contains(&input.assets.len()),
        "백테스트 종목은 1~20개까지 구성할 수 있습니다."
    );
    ensure!(
        input.initial_amount.is_finite() && input.initial_amount > 0.0,
        "초기 투자금은 0보다 커야 합니다."
    );
    ensure!(
        input.transaction_cost_bps.is_finite()
            && (0.0..=500.0).contains(&input.transaction_cost_bps),
        "거래비용은 0bp 이상 500bp 이하로 입력해 주세요."
    );
    let costs = &input.realism.costs;
    ensure!(
        costs
            .commission_bps
            .is_none_or(|value| value.is_finite() && (0.0..=5_000.0).contains(&value))
            && costs.sell_tax_bps.is_finite()
            && (0.0..=5_000.0).contains(&costs.sell_tax_bps)
            && costs.fixed_slippage_bps.is_finite()
            && (0.0..=5_000.0).contains(&costs.fixed_slippage_bps)
            && costs.dividend_tax_bps.is_finite()
            && (0.0..=10_000.0).contains(&costs.dividend_tax_bps)
            && costs.market_impact_coefficient.is_finite()
            && (0.0..=1.0).contains(&costs.market_impact_coefficient)
            && costs.market_impact_exponent.is_finite()
            && (0.1..=2.0).contains(&costs.market_impact_exponent)
            && costs.minimum_fee.is_finite()
            && costs.minimum_fee >= 0.0
            && costs
                .max_participation_rate_percent
                .is_none_or(|value| { value.is_finite() && (0.0..=100.0).contains(&value) }),
        "수수료·세금·슬리피지·시장충격 비용 모형의 입력 범위를 확인해 주세요."
    );
    ensure!(
        input.execution.cash_target_percent.is_finite()
            && (0.0..=100.0).contains(&input.execution.cash_target_percent),
        "현금 목표 비중은 0~100%여야 합니다."
    );
    ensure!(
        input.execution.cash_annual_yield_percent.is_finite()
            && (-100.0..=100.0).contains(&input.execution.cash_annual_yield_percent),
        "현금 연수익률은 -100~100%여야 합니다."
    );
    let asset_total = input.assets.iter().map(|asset| asset.weight).sum::<f64>();
    ensure!(
        input.assets.iter().all(|asset| asset.weight.is_finite()
            && asset.weight >= 0.0
            && asset.lot_size.is_finite()
            && asset.lot_size > 0.0),
        "종목 비중과 lot size를 확인해 주세요."
    );
    if input.realism.enforce_point_in_time_universe {
        ensure!(
            input.assets.iter().all(|asset| {
                asset.universe_member_from.as_ref().is_some_and(|from| {
                    asset.universe_member_to.as_ref().is_some_and(|to| {
                        from < to
                            && from <= &input.end_date
                            && to > &input.requested_start_date
                            && asset
                                .delist_date
                                .as_ref()
                                .is_none_or(|delist| delist > from)
                    })
                })
            }),
            "point-in-time universe를 강제하려면 모든 종목에 분석 기간과 겹치는 유효한 [membershipFrom, membershipTo) 구간이 필요합니다."
        );
    }
    ensure!(
        (asset_total + input.execution.cash_target_percent - 100.0).abs() <= 0.01,
        "종목과 현금 목표 비중 합계는 100%여야 합니다."
    );
    if input.rebalance_frequency == RebalanceFrequency::Threshold {
        ensure!(
            (0.1..=50.0).contains(&input.rebalance_threshold_percent),
            "threshold 리밸런싱 기준은 0.1% 이상 50% 이하로 입력해 주세요."
        );
    }
    ensure!(
        input.cash_flows.len() <= 1_000,
        "사용자 지정 현금흐름은 최대 1,000개입니다."
    );
    ensure!(
        input.target_weight_schedule.len() <= 10_000,
        "target weight schedule은 최대 10,000개입니다."
    );
    for entry in &input.target_weight_schedule {
        ensure!(
            entry.date >= input.requested_start_date && entry.date <= input.end_date,
            "target weight schedule 날짜는 백테스트 기간 안이어야 합니다."
        );
        ensure!(
            entry.weights.len() == input.assets.len()
                && input
                    .assets
                    .iter()
                    .all(|asset| entry.weights.contains_key(&asset.symbol)),
            "target weight schedule은 모든 종목의 명시적 비중을 포함해야 합니다."
        );
        let total = entry.weights.values().sum::<f64>() + entry.cash_target_percent;
        ensure!(
            entry
                .weights
                .values()
                .all(|weight| weight.is_finite() && *weight >= 0.0)
                && entry.cash_target_percent.is_finite()
                && entry.cash_target_percent >= 0.0
                && (total - 100.0).abs() <= 0.01,
            "target weight schedule의 종목·현금 비중 합계는 100%여야 합니다."
        );
    }
    ensure!(
        input
            .cash_flows
            .iter()
            .all(|flow| flow.amount.is_finite() && flow.amount.abs() <= 1e12),
        "현금흐름 금액 범위를 확인해 주세요."
    );
    ensure!(
        input
            .cash_flows
            .iter()
            .all(|flow| flow.date >= input.requested_start_date && flow.date <= input.end_date),
        "현금흐름 날짜는 백테스트 기간 안이어야 합니다."
    );
    Ok(())
}

fn rounded_quantity(raw: f64, mode: QuantityMode, lot_size: f64, round_up: bool) -> f64 {
    if raw <= EPSILON {
        return 0.0;
    }
    if mode == QuantityMode::Fractional {
        return raw;
    }
    let lots = raw / lot_size;
    let count = if round_up {
        (lots - EPSILON).ceil()
    } else {
        (lots + EPSILON).floor()
    };
    (count.max(0.0) * lot_size * 1e10).round() / 1e10
}

#[derive(Default)]
struct TradeFriction {
    quantity: f64,
    commission: f64,
    tax: f64,
    slippage: f64,
    market_impact: f64,
    participation_rate_percent: Option<f64>,
}

impl TradeFriction {
    fn total(&self) -> f64 {
        self.commission + self.tax + self.slippage + self.market_impact
    }
}

fn trade_friction(
    ledger: &Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    asset_index: usize,
    requested_quantity: f64,
    is_sell: bool,
) -> TradeFriction {
    let model = &input.realism.costs;
    let volume = ledger.volumes.get(asset_index).copied().flatten();
    let mut quantity = requested_quantity.max(0.0);
    if let (Some(daily_volume), Some(maximum)) = (volume, model.max_participation_rate_percent)
        && daily_volume.is_finite()
        && daily_volume > 0.0
    {
        quantity = quantity.min(daily_volume * maximum / 100.0);
    }
    let amount = quantity * prices[asset_index];
    if amount <= EPSILON {
        return TradeFriction::default();
    }
    let participation = volume
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| quantity / value)
        .filter(|value| value.is_finite() && *value >= 0.0);
    let commission_bps = model.commission_bps.unwrap_or(input.transaction_cost_bps);
    let commission = (amount * commission_bps / 10_000.0).max(model.minimum_fee);
    let tax = if is_sell {
        amount * model.sell_tax_bps / 10_000.0
    } else {
        0.0
    };
    let slippage = amount * model.fixed_slippage_bps / 10_000.0;
    let market_impact = participation
        .map(|rate| {
            amount * model.market_impact_coefficient * rate.powf(model.market_impact_exponent)
        })
        .unwrap_or(0.0);
    TradeFriction {
        quantity,
        commission,
        tax,
        slippage,
        market_impact,
        participation_rate_percent: participation.map(|value| value * 100.0),
    }
}

fn record_liquidity_quality(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    asset_index: usize,
) {
    if input.realism.costs.market_impact_coefficient > 0.0
        || input.realism.costs.max_participation_rate_percent.is_some()
    {
        ledger.liquidity_observations += 1;
        if ledger
            .volumes
            .get(asset_index)
            .copied()
            .flatten()
            .is_none_or(|value| !value.is_finite() || value <= 0.0)
        {
            ledger.missing_liquidity_observations += 1;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn sell(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    asset_index: usize,
    requested_quantity: f64,
    date: &str,
    reason: &str,
    trigger: &str,
) -> f64 {
    let requested_quantity = requested_quantity
        .min(ledger.quantities[asset_index])
        .max(0.0);
    if requested_quantity <= EPSILON {
        return 0.0;
    }
    let friction = trade_friction(ledger, input, prices, asset_index, requested_quantity, true);
    let quantity = friction.quantity.min(ledger.quantities[asset_index]);
    let amount = quantity * prices[asset_index];
    let cost = friction.total();
    if quantity <= EPSILON || cost >= amount {
        return 0.0;
    }
    record_liquidity_quality(ledger, input, asset_index);
    ledger.quantities[asset_index] -= quantity;
    ledger.cash += amount - cost;
    ledger.total_costs += cost;
    ledger.trades.push(TradeEvent {
        asset_index,
        date: date.to_owned(),
        symbol: input.assets[asset_index].symbol.clone(),
        side: "SELL".into(),
        amount: round(amount, 2),
        quantity,
        price: prices[asset_index],
        reason: reason.into(),
        transaction_cost: round(cost, 2),
        commission: round(friction.commission, 2),
        tax: round(friction.tax, 2),
        slippage_cost: round(friction.slippage, 2),
        market_impact_cost: round(friction.market_impact, 2),
        participation_rate_percent: friction
            .participation_rate_percent
            .map(|value| round(value, 6)),
        net_cash_impact: round(amount - cost, 2),
        trigger: trigger.into(),
        lot_size: input.assets[asset_index].lot_size,
    });
    amount - cost
}

#[allow(clippy::too_many_arguments)]
fn buy(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    asset_index: usize,
    requested_quantity: f64,
    date: &str,
    reason: &str,
    trigger: &str,
) -> f64 {
    let affordable = ledger.cash / prices[asset_index];
    let raw = requested_quantity.min(affordable).max(0.0);
    let mut quantity = rounded_quantity(
        raw,
        input.execution.quantity_mode,
        input.assets[asset_index].lot_size,
        false,
    );
    let mut friction = trade_friction(ledger, input, prices, asset_index, quantity, false);
    quantity = rounded_quantity(
        friction.quantity,
        input.execution.quantity_mode,
        input.assets[asset_index].lot_size,
        false,
    );
    friction = trade_friction(ledger, input, prices, asset_index, quantity, false);
    let mut impact = quantity * prices[asset_index] + friction.total();
    if impact > ledger.cash + 0.0001 {
        quantity = rounded_quantity(
            quantity * ledger.cash / impact,
            input.execution.quantity_mode,
            input.assets[asset_index].lot_size,
            false,
        );
        friction = trade_friction(ledger, input, prices, asset_index, quantity, false);
        impact = quantity * prices[asset_index] + friction.total();
    }
    if quantity <= EPSILON || impact > ledger.cash + 0.0001 {
        return 0.0;
    }
    let amount = quantity * prices[asset_index];
    let cost = friction.total();
    record_liquidity_quality(ledger, input, asset_index);
    ledger.quantities[asset_index] += quantity;
    ledger.cash = (ledger.cash - impact).max(0.0);
    ledger.total_costs += cost;
    ledger.trades.push(TradeEvent {
        asset_index,
        date: date.to_owned(),
        symbol: input.assets[asset_index].symbol.clone(),
        side: "BUY".into(),
        amount: round(amount, 2),
        quantity,
        price: prices[asset_index],
        reason: reason.into(),
        transaction_cost: round(cost, 2),
        commission: round(friction.commission, 2),
        tax: 0.0,
        slippage_cost: round(friction.slippage, 2),
        market_impact_cost: round(friction.market_impact, 2),
        participation_rate_percent: friction
            .participation_rate_percent
            .map(|value| round(value, 6)),
        net_cash_impact: round(-impact, 2),
        trigger: trigger.into(),
        lot_size: input.assets[asset_index].lot_size,
    });
    impact
}

#[allow(clippy::too_many_arguments)]
fn buy_desired(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    desired: &[(usize, f64)],
    maximum_cash: f64,
    date: &str,
    reason: &str,
    trigger: &str,
) {
    let cost_rate = input.transaction_cost_bps / 10_000.0;
    let available = ledger.cash.min(maximum_cash).max(0.0);
    if available <= EPSILON {
        return;
    }
    if input.execution.quantity_mode == QuantityMode::Fractional {
        let total_impact = desired
            .iter()
            .map(|(_, notional)| notional.max(0.0) * (1.0 + cost_rate))
            .sum::<f64>();
        let scale = if total_impact > available {
            available / total_impact
        } else {
            1.0
        };
        for (index, notional) in desired {
            let quantity = notional.max(0.0) * scale / prices[*index];
            buy(
                ledger, input, prices, *index, quantity, date, reason, trigger,
            );
        }
        return;
    }
    let mut sorted = desired.to_vec();
    sorted.sort_by(|(left_index, left), (right_index, right)| {
        right.total_cmp(left).then_with(|| {
            input.assets[*left_index]
                .symbol
                .cmp(&input.assets[*right_index].symbol)
        })
    });
    let reserve = (ledger.cash - available).max(0.0);
    for (index, notional) in sorted {
        let spendable = (ledger.cash - reserve).max(0.0);
        let quantity = rounded_quantity(
            (notional / prices[index]).min(spendable / (prices[index] * (1.0 + cost_rate))),
            QuantityMode::Whole,
            input.assets[index].lot_size,
            false,
        );
        buy(
            ledger, input, prices, index, quantity, date, reason, trigger,
        );
    }
}

fn full_rebalance(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    date: &str,
    reason: &str,
    trigger: &str,
) {
    let weights = ledger.target_weights.clone();
    let starting_equity = ledger.balance(prices);
    for index in 0..input.assets.len() {
        let current = ledger.quantities[index] * prices[index];
        let target = starting_equity * weights[index];
        if current > target + EPSILON {
            let quantity = rounded_quantity(
                (current - target) / prices[index],
                input.execution.quantity_mode,
                input.assets[index].lot_size,
                false,
            );
            sell(
                ledger, input, prices, index, quantity, date, reason, trigger,
            );
        }
    }
    let equity = ledger.balance(prices);
    let target_cash = equity * ledger.cash_target_percent / 100.0;
    let desired = (0..input.assets.len())
        .filter_map(|index| {
            let deficit = equity * weights[index] - ledger.quantities[index] * prices[index];
            (deficit > EPSILON).then_some((index, deficit))
        })
        .collect::<Vec<_>>();
    let available = (ledger.cash - target_cash).max(0.0);
    buy_desired(
        ledger, input, prices, &desired, available, date, reason, trigger,
    );
}

fn contribution_buys(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    amount: f64,
    date: &str,
    trigger: &str,
) {
    match input.execution.cash_flow_rebalance_mode {
        CashFlowRebalanceMode::Full => {
            full_rebalance(ledger, input, prices, date, "cash-flow", trigger)
        }
        CashFlowRebalanceMode::TargetWeights => {
            let desired = ledger
                .target_weights
                .iter()
                .enumerate()
                .filter_map(|(index, weight)| (*weight > 0.0).then_some((index, amount * weight)))
                .collect::<Vec<_>>();
            buy_desired(
                ledger,
                input,
                prices,
                &desired,
                amount,
                date,
                "cash-flow",
                trigger,
            );
        }
        CashFlowRebalanceMode::DriftReduction => {
            let equity = ledger.balance(prices);
            let weights = ledger.target_weights.clone();
            let desired = (0..input.assets.len())
                .filter_map(|index| {
                    let deficit =
                        equity * weights[index] - ledger.quantities[index] * prices[index];
                    (deficit > EPSILON).then_some((index, deficit))
                })
                .collect::<Vec<_>>();
            let target_cash = equity * ledger.cash_target_percent / 100.0;
            let available = (ledger.cash - target_cash).max(0.0);
            buy_desired(
                ledger,
                input,
                prices,
                &desired,
                available,
                date,
                "cash-flow",
                trigger,
            );
        }
    }
}

fn raise_cash(
    ledger: &mut Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
    required: f64,
    date: &str,
    trigger: &str,
) -> Result<()> {
    if ledger.cash + EPSILON >= required {
        return Ok(());
    }
    let cost_rate = input.transaction_cost_bps / 10_000.0;
    let equity = ledger.balance(prices);
    let weights = ledger.target_weights.clone();
    let mut indices = (0..input.assets.len()).collect::<Vec<_>>();
    indices.sort_by(|left, right| {
        let left_excess = ledger.quantities[*left] * prices[*left] - equity * weights[*left];
        let right_excess = ledger.quantities[*right] * prices[*right] - equity * weights[*right];
        right_excess
            .total_cmp(&left_excess)
            .then_with(|| input.assets[*left].symbol.cmp(&input.assets[*right].symbol))
    });
    for index in indices {
        if ledger.cash + EPSILON >= required {
            break;
        }
        let shortfall = required - ledger.cash;
        let raw_quantity = shortfall / (prices[index] * (1.0 - cost_rate).max(EPSILON));
        let quantity = rounded_quantity(
            raw_quantity,
            input.execution.quantity_mode,
            input.assets[index].lot_size,
            true,
        )
        .min(ledger.quantities[index]);
        sell(
            ledger,
            input,
            prices,
            index,
            quantity,
            date,
            "cash-flow",
            trigger,
        );
    }
    ensure!(
        ledger.cash + 0.0001 >= required,
        "출금에 필요한 현금이 부족합니다."
    );
    Ok(())
}

fn drift_exceeds_threshold(
    ledger: &Ledger,
    input: &BacktestSimulationInput,
    prices: &[f64],
) -> bool {
    let equity = ledger.balance(prices);
    if equity <= EPSILON {
        return false;
    }
    let target = &ledger.target_weights;
    let mut maximum: f64 = (ledger.cash / equity - ledger.cash_target_percent / 100.0).abs();
    for (index, target_weight) in target.iter().enumerate() {
        maximum =
            maximum.max((ledger.quantities[index] * prices[index] / equity - target_weight).abs());
    }
    maximum + EPSILON >= input.rebalance_threshold_percent / 100.0
}

fn summarize(
    points: &[(String, f64)],
    daily_returns: &[f64],
    risk_free_rate_percent: f64,
    initial_value: f64,
) -> (ComparableMetrics, Vec<AnnualReturn>) {
    let final_value = points.last().map(|item| item.1).unwrap_or(initial_value);
    let mut peak = initial_value;
    let mut peak_date = points.first().map(|item| item.0.as_str()).unwrap_or("");
    let mut maximum_drawdown = 0.0_f64;
    let mut maximum_drawdown_days = 0_i64;
    for (date, value) in points {
        if *value >= peak {
            peak = *value;
            peak_date = date;
        }
        let drawdown = if peak > 0.0 { value / peak - 1.0 } else { 0.0 };
        maximum_drawdown = maximum_drawdown.min(drawdown);
        if drawdown < 0.0 {
            maximum_drawdown_days = maximum_drawdown_days.max(days_between(peak_date, date));
        }
    }
    let mut year_end = BTreeMap::<String, f64>::new();
    let mut month_end = BTreeMap::<String, f64>::new();
    for (date, value) in points {
        year_end.insert(date[..4].to_owned(), *value);
        month_end.insert(date[..7].to_owned(), *value);
    }
    let mut previous = initial_value;
    let annual_returns = year_end
        .into_iter()
        .map(|(year, value)| {
            let result = AnnualReturn {
                year: year.parse().unwrap_or(0),
                return_percent: round((value / previous - 1.0) * 100.0, 4),
            };
            previous = value;
            result
        })
        .collect::<Vec<_>>();
    let mut previous_month = initial_value;
    let monthly_returns = month_end
        .into_values()
        .map(|value| {
            let result = value / previous_month - 1.0;
            previous_month = value;
            result
        })
        .collect::<Vec<_>>();
    let elapsed_years = points
        .first()
        .zip(points.last())
        .map(|(first, last)| days_between(&first.0, &last.0) as f64 / 365.25)
        .unwrap_or(0.0);
    let total_return = final_value / initial_value - 1.0;
    let volatility = sample_std(daily_returns);
    let daily_risk_free = (1.0 + risk_free_rate_percent / 100.0).powf(1.0 / 252.0) - 1.0;
    let excess = daily_returns
        .iter()
        .map(|value| value - daily_risk_free)
        .collect::<Vec<_>>();
    let mean_excess = average(&excess);
    let downside = if excess.is_empty() {
        0.0
    } else {
        (excess
            .iter()
            .map(|value| value.min(0.0).powi(2))
            .sum::<f64>()
            / excess.len() as f64)
            .sqrt()
    };
    let cagr = (elapsed_years > 0.0 && final_value > 0.0).then(|| {
        round(
            ((final_value / initial_value).powf(1.0 / elapsed_years) - 1.0) * 100.0,
            4,
        )
    });
    let max_drawdown_percent = round(maximum_drawdown * 100.0, 4);
    (
        ComparableMetrics {
            total_return_percent: round(total_return * 100.0, 4),
            cagr_percent: cagr,
            annualized_volatility_percent: (daily_returns.len() > 1)
                .then(|| round(volatility * 252_f64.sqrt() * 100.0, 4)),
            max_drawdown_percent,
            max_drawdown_days: maximum_drawdown_days,
            sharpe_ratio: (volatility > 0.0)
                .then(|| round(mean_excess / volatility * 252_f64.sqrt(), 4)),
            sortino_ratio: (downside > 0.0)
                .then(|| round(mean_excess / downside * 252_f64.sqrt(), 4)),
            calmar_ratio: cagr
                .filter(|_| max_drawdown_percent < 0.0)
                .map(|value| round(value / max_drawdown_percent.abs(), 4)),
            best_daily_return_percent: daily_returns
                .iter()
                .copied()
                .max_by(f64::total_cmp)
                .map(|value| round(value * 100.0, 4)),
            worst_daily_return_percent: daily_returns
                .iter()
                .copied()
                .min_by(f64::total_cmp)
                .map(|value| round(value * 100.0, 4)),
            positive_days_percent: (!daily_returns.is_empty()).then(|| {
                round(
                    daily_returns.iter().filter(|value| **value > 0.0).count() as f64
                        / daily_returns.len() as f64
                        * 100.0,
                    4,
                )
            }),
            best_year_percent: annual_returns
                .iter()
                .map(|item| item.return_percent)
                .max_by(f64::total_cmp),
            worst_year_percent: annual_returns
                .iter()
                .map(|item| item.return_percent)
                .min_by(f64::total_cmp),
            positive_months_percent: (!monthly_returns.is_empty()).then(|| {
                round(
                    monthly_returns.iter().filter(|value| **value > 0.0).count() as f64
                        / monthly_returns.len() as f64
                        * 100.0,
                    4,
                )
            }),
        },
        annual_returns,
    )
}

fn common_observed_returns(
    series_by_asset: &[Vec<PricePoint>],
    observed_by_asset: &[BTreeSet<String>],
) -> (Vec<Vec<f64>>, usize) {
    if series_by_asset.is_empty() {
        return (Vec::new(), 0);
    }
    let maps = series_by_asset
        .iter()
        .enumerate()
        .map(|(index, series)| {
            series
                .iter()
                .filter(|point| observed_by_asset[index].contains(&point.date))
                .map(|point| (point.date.clone(), point.close))
                .collect::<BTreeMap<_, _>>()
        })
        .collect::<Vec<_>>();
    let dates = observed_by_asset[0]
        .iter()
        .filter(|date| maps.iter().all(|values| values.contains_key(*date)))
        .cloned()
        .collect::<Vec<_>>();
    let mut returns = vec![Vec::new(); series_by_asset.len()];
    for pair in dates.windows(2) {
        for (index, values) in maps.iter().enumerate() {
            let previous = values[&pair[0]];
            let current = values[&pair[1]];
            if previous > 0.0 && current > 0.0 {
                returns[index].push(current / previous - 1.0);
            }
        }
    }
    (returns, dates.len().saturating_sub(1))
}

pub fn simulate(input: &BacktestSimulationInput) -> Result<BacktestSimulationResult> {
    simulate_with_control(input, None)
}

pub fn simulate_with_control(
    input: &BacktestSimulationInput,
    control: Option<&dyn ComputeControl>,
) -> Result<BacktestSimulationResult> {
    checkpoint(control)?;
    validate(input)?;
    let (
        aligned,
        series_by_asset,
        benchmark_series,
        observed_by_asset,
        benchmark_observed,
        carry_forward,
        benchmark_carry_forward,
    ) = align(input)?;
    checkpoint(control)?;
    let first = &aligned[0];
    let mut target_schedule = input.target_weight_schedule.clone();
    target_schedule.sort_by(|left, right| left.date.cmp(&right.date));
    let initial_schedule_count = target_schedule
        .iter()
        .take_while(|entry| entry.date <= first.date)
        .count();
    let initial_schedule = initial_schedule_count
        .checked_sub(1)
        .and_then(|index| target_schedule.get(index));
    let initial_policy_weights = initial_schedule
        .map(|entry| scheduled_target_weights(input, entry))
        .unwrap_or_else(|| configured_target_weights(input));
    let initial_policy_cash = initial_schedule
        .map(|entry| entry.cash_target_percent)
        .unwrap_or(input.execution.cash_target_percent);
    let (initial_target_weights, initial_cash_target) = effective_target_weights(
        input,
        &initial_policy_weights,
        initial_policy_cash,
        &first.date,
    );
    let mut ledger = Ledger {
        quantities: vec![0.0; input.assets.len()],
        volumes: first.volumes.clone(),
        policy_target_weights: initial_policy_weights,
        policy_cash_target_percent: initial_policy_cash,
        target_weights: initial_target_weights,
        cash_target_percent: initial_cash_target,
        cash: input.initial_amount,
        units: input.initial_amount,
        ..Ledger::default()
    };
    full_rebalance(
        &mut ledger,
        input,
        &first.closes,
        &first.date,
        "initial",
        "initial",
    );

    let mut custom_by_index = BTreeMap::<usize, Vec<CustomCashFlow>>::new();
    for flow in &input.cash_flows {
        let index = aligned
            .iter()
            .position(|point| point.date >= flow.date && point.common_observation(input))
            .ok_or_else(|| {
                anyhow::anyhow!("{} 현금흐름을 적용할 공통 거래일이 없습니다.", flow.date)
            })?;
        custom_by_index.entry(index).or_default().push(flow.clone());
    }

    let mut total_contributions = input.initial_amount;
    let mut total_withdrawals = 0.0;
    let mut applied_flows = Vec::<AppliedCashFlow>::new();
    let mut applied_target_schedule = initial_schedule
        .map(|entry| {
            vec![AppliedTargetWeightSchedule {
                scheduled_date: entry.date.clone(),
                effective_date: first.date.clone(),
                weights: entry.weights.clone(),
                cash_target_percent: entry.cash_target_percent,
                regime: entry.regime.clone(),
                action: entry.action.clone(),
            }]
        })
        .unwrap_or_default();
    let mut target_schedule_cursor = initial_schedule_count;
    let mut xirr_flows = vec![(first.date.clone(), -input.initial_amount)];
    let mut pending_periodic = Vec::<(String, f64)>::new();
    let mut pending_rebalance = false;
    let mut points = Vec::<BacktestPoint>::new();
    let mut growth_points = Vec::<(String, f64)>::new();
    let mut portfolio_returns = Vec::<f64>::new();
    let mut return_points = Vec::<(String, f64)>::new();
    let mut benchmark_returns = Vec::<f64>::new();
    let mut benchmark_growth_points = Vec::<(String, f64)>::new();
    let mut asset_returns = vec![Vec::<f64>::new(); input.assets.len()];
    let mut market_profit = vec![0.0; input.assets.len()];
    let mut linked = vec![0.0; input.assets.len()];
    let mut linked_local = vec![0.0; input.assets.len()];
    let mut linked_fx = vec![0.0; input.assets.len()];
    let mut linked_up = vec![0.0; input.assets.len()];
    let mut linked_down = vec![0.0; input.assets.len()];
    let mut weight_sums = vec![0.0; input.assets.len()];
    let mut weight_observations = 0_usize;
    let mut peak_growth = input.initial_amount;
    let benchmark_base = first.benchmark_close.unwrap_or(0.0);

    for index in 0..aligned.len() {
        checkpoint(control)?;
        let current = &aligned[index];
        ledger.volumes.clone_from(&current.volumes);
        if index > 0 {
            let previous = &aligned[index - 1];
            let elapsed_days = days_between(&previous.date, &current.date) as f64;
            if ledger.cash > 0.0 && input.execution.cash_annual_yield_percent != 0.0 {
                ledger.cash *= (1.0 + input.execution.cash_annual_yield_percent / 100.0)
                    .powf(elapsed_days / 365.25);
            }
            let before_market = ledger.balance(&previous.closes);
            let dividend_tax_rate = input.realism.costs.dividend_tax_bps / 10_000.0;
            let mut daily_contributions = vec![0.0; input.assets.len()];
            let mut daily_local_contributions = vec![0.0; input.assets.len()];
            let mut daily_fx_contributions = vec![0.0; input.assets.len()];
            for asset_index in 0..input.assets.len() {
                let previous_value = ledger.quantities[asset_index] * previous.closes[asset_index];
                let previous_weight = if before_market > 0.0 {
                    previous_value / before_market
                } else {
                    0.0
                };
                weight_sums[asset_index] += previous_weight;
                let cash_dividend = if input.realism.dividend_mode == DividendMode::Cash {
                    current.cash_dividends[asset_index].max(0.0)
                } else {
                    0.0
                };
                let net_dividend_per_share = cash_dividend * (1.0 - dividend_tax_rate);
                let dividend_return = if previous.closes[asset_index] > 0.0 {
                    net_dividend_per_share / previous.closes[asset_index]
                } else {
                    0.0
                };
                let asset_return = current.closes[asset_index] / previous.closes[asset_index] - 1.0
                    + dividend_return;
                let local_return =
                    current.local_closes[asset_index] / previous.local_closes[asset_index] - 1.0
                        + dividend_return;
                let fx_return =
                    current.fx_rates[asset_index] / previous.fx_rates[asset_index] - 1.0;
                asset_returns[asset_index].push(asset_return);
                market_profit[asset_index] += ledger.quantities[asset_index]
                    * (current.closes[asset_index] - previous.closes[asset_index]);
                if cash_dividend > 0.0 && ledger.quantities[asset_index] > EPSILON {
                    let gross = ledger.quantities[asset_index] * cash_dividend;
                    let tax = gross * dividend_tax_rate;
                    let net = gross - tax;
                    ledger.cash += net;
                    ledger.total_dividend_income += gross;
                    ledger.total_dividend_taxes += tax;
                    ledger.dividends.push(DividendEvent {
                        date: current.date.clone(),
                        symbol: input.assets[asset_index].symbol.clone(),
                        quantity: ledger.quantities[asset_index],
                        amount_per_share: round(cash_dividend, 8),
                        gross_amount: round(gross, 2),
                        tax: round(tax, 2),
                        net_amount: round(net, 2),
                    });
                    market_profit[asset_index] += net;
                }
                daily_contributions[asset_index] = previous_weight * asset_return;
                daily_local_contributions[asset_index] = previous_weight * local_return;
                daily_fx_contributions[asset_index] =
                    previous_weight * (1.0 + local_return) * fx_return;
            }
            let after_market = ledger.balance(&current.closes);
            let market_return = if before_market > EPSILON {
                after_market / before_market - 1.0
            } else {
                0.0
            };
            for asset_index in 0..input.assets.len() {
                linked[asset_index] =
                    linked[asset_index] * (1.0 + market_return) + daily_contributions[asset_index];
                linked_local[asset_index] = linked_local[asset_index] * (1.0 + market_return)
                    + daily_local_contributions[asset_index];
                linked_fx[asset_index] = linked_fx[asset_index] * (1.0 + market_return)
                    + daily_fx_contributions[asset_index];
                linked_up[asset_index] = linked_up[asset_index] * (1.0 + market_return)
                    + if market_return >= 0.0 {
                        daily_contributions[asset_index]
                    } else {
                        0.0
                    };
                linked_down[asset_index] = linked_down[asset_index] * (1.0 + market_return)
                    + if market_return < 0.0 {
                        daily_contributions[asset_index]
                    } else {
                        0.0
                    };
            }
            weight_observations += 1;
            if input.monthly_cash_flow != 0.0
                && cash_flow_due(
                    &previous.date,
                    &current.date,
                    aligned.get(index + 1).map(|point| point.date.as_str()),
                    input.cash_flow_frequency,
                    input.cash_flow_timing,
                )
            {
                pending_periodic.push((current.date.clone(), input.monthly_cash_flow));
            }
            if scheduled_rebalance(&previous.date, &current.date, input.rebalance_frequency) {
                pending_rebalance = true;
            }
        }

        if current.common_observation(input) {
            let (universe_weights, universe_cash) = effective_target_weights(
                input,
                &ledger.policy_target_weights,
                ledger.policy_cash_target_percent,
                &current.date,
            );
            let universe_changed = universe_weights
                .iter()
                .zip(&ledger.target_weights)
                .any(|(left, right)| (left - right).abs() > EPSILON)
                || (universe_cash - ledger.cash_target_percent).abs() > EPSILON;
            let mut scheduled_policy_applied = false;
            while let Some(entry) = target_schedule.get(target_schedule_cursor)
                && entry.date <= current.date
            {
                ledger.policy_target_weights = scheduled_target_weights(input, entry);
                ledger.policy_cash_target_percent = entry.cash_target_percent;
                (ledger.target_weights, ledger.cash_target_percent) = effective_target_weights(
                    input,
                    &ledger.policy_target_weights,
                    ledger.policy_cash_target_percent,
                    &current.date,
                );
                full_rebalance(
                    &mut ledger,
                    input,
                    &current.closes,
                    &current.date,
                    "policy-schedule",
                    "regime_policy",
                );
                applied_target_schedule.push(AppliedTargetWeightSchedule {
                    scheduled_date: entry.date.clone(),
                    effective_date: current.date.clone(),
                    weights: entry.weights.clone(),
                    cash_target_percent: entry.cash_target_percent,
                    regime: entry.regime.clone(),
                    action: entry.action.clone(),
                });
                target_schedule_cursor += 1;
                scheduled_policy_applied = true;
            }
            if universe_changed && !scheduled_policy_applied {
                ledger.target_weights = universe_weights;
                ledger.cash_target_percent = universe_cash;
                full_rebalance(
                    &mut ledger,
                    input,
                    &current.closes,
                    &current.date,
                    "point-in-time-universe",
                    "point_in_time_universe",
                );
            }
            let mut events = custom_by_index
                .remove(&index)
                .unwrap_or_default()
                .into_iter()
                .map(|flow| AppliedCashFlow {
                    scheduled_date: flow.date,
                    effective_date: current.date.clone(),
                    amount: flow.amount,
                    source: "custom".into(),
                    memo: flow.memo,
                })
                .collect::<Vec<_>>();
            events.extend(
                pending_periodic
                    .drain(..)
                    .map(|(scheduled, amount)| AppliedCashFlow {
                        scheduled_date: scheduled,
                        effective_date: current.date.clone(),
                        amount,
                        source: "periodic".into(),
                        memo: None,
                    }),
            );
            let net_flow = events.iter().map(|flow| flow.amount).sum::<f64>();
            let contributions = events.iter().map(|flow| flow.amount.max(0.0)).sum::<f64>();
            let withdrawals = events
                .iter()
                .map(|flow| (-flow.amount).max(0.0))
                .sum::<f64>();
            total_contributions += contributions;
            total_withdrawals += withdrawals;
            if net_flow.abs() > EPSILON {
                let nav_before = ledger.unit_price(&current.closes);
                if net_flow > 0.0 {
                    ledger.cash += net_flow;
                    if nav_before > EPSILON {
                        ledger.units += net_flow / nav_before;
                    }
                    contribution_buys(
                        &mut ledger,
                        input,
                        &current.closes,
                        net_flow,
                        &current.date,
                        if events.iter().any(|flow| flow.source == "custom") {
                            "custom_cash_flow"
                        } else {
                            "periodic_cash_flow"
                        },
                    );
                } else {
                    let withdrawal = -net_flow;
                    ensure!(
                        withdrawal <= ledger.balance(&current.closes) + 0.0001,
                        "출금액이 포트폴리오 가치보다 큽니다."
                    );
                    raise_cash(
                        &mut ledger,
                        input,
                        &current.closes,
                        withdrawal,
                        &current.date,
                        "cash_flow_rebalance",
                    )?;
                    ledger.cash -= withdrawal;
                    if nav_before > EPSILON {
                        ledger.units = (ledger.units - withdrawal / nav_before).max(0.0);
                    }
                    if input.execution.cash_flow_rebalance_mode == CashFlowRebalanceMode::Full {
                        full_rebalance(
                            &mut ledger,
                            input,
                            &current.closes,
                            &current.date,
                            "cash-flow",
                            "cash_flow_rebalance",
                        );
                    }
                }
            }
            for event in &events {
                xirr_flows.push((event.effective_date.clone(), -event.amount));
            }
            applied_flows.extend(events);
            let threshold = input.rebalance_frequency == RebalanceFrequency::Threshold
                && drift_exceeds_threshold(&ledger, input, &current.closes);
            if pending_rebalance || threshold {
                full_rebalance(
                    &mut ledger,
                    input,
                    &current.closes,
                    &current.date,
                    "rebalance",
                    if threshold {
                        "threshold_rebalance"
                    } else {
                        "scheduled_rebalance"
                    },
                );
                pending_rebalance = false;
            }
        }

        let balance = ledger.balance(&current.closes);
        let invested = ledger.invested(&current.closes);
        let unit_price = ledger.unit_price(&current.closes);
        let growth = input.initial_amount * unit_price;
        if index > 0 {
            let previous_unit = points.last().map(|point| point.unit_price).unwrap_or(1.0);
            let portfolio_return = if previous_unit > 0.0 {
                unit_price / previous_unit - 1.0
            } else {
                0.0
            };
            portfolio_returns.push(portfolio_return);
            return_points.push((current.date.clone(), portfolio_return));
            if let (Some(previous), Some(now)) =
                (aligned[index - 1].benchmark_close, current.benchmark_close)
                && previous > 0.0
            {
                benchmark_returns.push(now / previous - 1.0);
            }
        }
        let benchmark_growth = current
            .benchmark_close
            .filter(|_| benchmark_base > 0.0)
            .map(|value| input.initial_amount * value / benchmark_base);
        if let Some(value) = benchmark_growth {
            benchmark_growth_points.push((current.date.clone(), value));
        }
        peak_growth = peak_growth.max(growth);
        let drawdown = if peak_growth > 0.0 {
            growth / peak_growth - 1.0
        } else {
            0.0
        };
        points.push(BacktestPoint {
            date: current.date.clone(),
            balance: round(balance, 2),
            growth: round(growth, 2),
            benchmark_growth: benchmark_growth.map(|value| round(value, 2)),
            drawdown_percent: round(drawdown * 100.0, 4),
            cash_balance: round(ledger.cash, 2),
            invested_balance: round(invested, 2),
            unit_price: round(unit_price, 8),
        });
        growth_points.push((current.date.clone(), growth));
    }

    let (comparable, annual_returns) = summarize(
        &growth_points,
        &portfolio_returns,
        input.risk_free_rate_percent,
        input.initial_amount,
    );
    let benchmark_metrics = input.benchmark.as_ref().map(|_| {
        summarize(
            &benchmark_growth_points,
            &benchmark_returns,
            input.risk_free_rate_percent,
            input.initial_amount,
        )
        .0
    });
    let final_balance = ledger.balance(&aligned.last().unwrap().closes);
    xirr_flows.push((aligned.last().unwrap().date.clone(), final_balance));
    xirr_flows.sort_by(|left, right| left.0.cmp(&right.0));
    let money_weighted = xirr(&xirr_flows).map(|value| round(value * 100.0, 4));
    let final_invested = ledger.invested(&aligned.last().unwrap().closes);
    let ending_weights = ledger
        .quantities
        .iter()
        .zip(&aligned.last().unwrap().closes)
        .map(|(quantity, price)| {
            if final_balance > 0.0 {
                quantity * price / final_balance
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let average_weights = if weight_observations > 0 {
        weight_sums
            .iter()
            .map(|value| value / weight_observations as f64)
            .collect::<Vec<_>>()
    } else {
        configured_target_weights(input)
    };
    let mut contributions = input
        .assets
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            let first_price = series_by_asset[index]
                .first()
                .map(|point| point.close)
                .unwrap_or(1.0);
            let last_price = series_by_asset[index]
                .last()
                .map(|point| point.close)
                .unwrap_or(first_price);
            Contribution {
                symbol: asset.symbol.clone(),
                name: asset.name.clone(),
                market: asset.market.clone(),
                currency: asset.currency.clone(),
                weight: asset.weight,
                ending_value: round(
                    ledger.quantities[index] * aligned.last().unwrap().closes[index],
                    2,
                ),
                profit_loss: round(market_profit[index], 2),
                contribution_percent: if input.initial_amount > 0.0 {
                    round(market_profit[index] / input.initial_amount * 100.0, 4)
                } else {
                    0.0
                },
                time_linked_contribution_percent: round(linked[index] * 100.0, 4),
                local_price_contribution_percent: round(linked_local[index] * 100.0, 4),
                fx_contribution_percent: round(linked_fx[index] * 100.0, 4),
                up_regime_contribution_percent: round(linked_up[index] * 100.0, 4),
                down_regime_contribution_percent: round(linked_down[index] * 100.0, 4),
                asset_return_percent: round((last_price / first_price - 1.0) * 100.0, 4),
            }
        })
        .collect::<Vec<_>>();
    contributions.sort_by(|left, right| {
        right
            .contribution_percent
            .total_cmp(&left.contribution_percent)
    });

    let (common_returns, common_observations) =
        common_observed_returns(&series_by_asset, &observed_by_asset);
    checkpoint(control)?;
    let correlation_values = (0..input.assets.len())
        .map(|left| {
            (0..input.assets.len())
                .map(|right| {
                    if left == right {
                        Some(1.0)
                    } else {
                        correlation(&common_returns[left], &common_returns[right])
                    }
                })
                .collect()
        })
        .collect();
    let price_coverage = series_by_asset
        .iter()
        .enumerate()
        .map(|(index, series)| {
            let observed = series
                .iter()
                .filter(|point| observed_by_asset[index].contains(&point.date))
                .collect::<Vec<_>>();
            PriceCoverage {
                observations: observed.len(),
                aligned_days: aligned.len(),
                first_date: observed
                    .first()
                    .map(|point| point.date.clone())
                    .unwrap_or_else(|| aligned[0].date.clone()),
                last_date: observed
                    .last()
                    .map(|point| point.date.clone())
                    .unwrap_or_else(|| aligned.last().unwrap().date.clone()),
            }
        })
        .collect::<Vec<_>>();
    let advanced = crate::analytics::calculate(AdvancedAnalyticsInput {
        assets: &input.assets,
        base_date: &aligned[0].date,
        effective_end_date: &aligned.last().unwrap().date,
        requested_start_date: &input.requested_start_date,
        returns: &return_points,
        asset_returns: &asset_returns,
        benchmark: input
            .benchmark
            .as_ref()
            .map(|benchmark| BenchmarkAnalyticsInput {
                key: benchmark.key.clone(),
                name: benchmark.name.clone(),
                returns: benchmark_returns.clone(),
                observations: benchmark_series
                    .iter()
                    .filter(|point| benchmark_observed.contains(&point.date))
                    .count(),
            }),
        average_weights: &average_weights,
        ending_weights: &ending_weights,
        trades: &ledger.trades,
        balances: &growth_points,
        transaction_cost_bps: input.transaction_cost_bps,
        risk_free_rate_percent: input.risk_free_rate_percent,
        gross_return_percent: comparable.total_return_percent,
        actual_total_cost: ledger.total_costs,
        cash_weight: if final_balance > 0.0 {
            ledger.cash / final_balance
        } else {
            0.0
        },
        price_coverage: &price_coverage,
    });
    checkpoint(control)?;
    let result = BacktestSimulationResult {
        requested_start_date: input.requested_start_date.clone(),
        effective_start_date: aligned[0].date.clone(),
        end_date: aligned.last().unwrap().date.clone(),
        points,
        metrics: BacktestMetrics {
            comparable,
            final_balance: round(final_balance, 2),
            total_contributions: round(total_contributions, 2),
            total_withdrawals: round(total_withdrawals, 2),
            ending_cash_balance: round(ledger.cash, 2),
            ending_cash_weight_percent: if final_balance > 0.0 {
                round(ledger.cash / final_balance * 100.0, 4)
            } else {
                0.0
            },
            invested_balance: round(final_invested, 2),
            total_transaction_costs: round(ledger.total_costs, 2),
            total_dividend_income: round(ledger.total_dividend_income, 2),
            total_dividend_taxes: round(ledger.total_dividend_taxes, 2),
            net_profit_loss: round(final_balance + total_withdrawals - total_contributions, 2),
            money_weighted_return_percent: money_weighted,
        },
        benchmark_metrics,
        annual_returns,
        contributions,
        correlations: Correlations {
            assets: input
                .assets
                .iter()
                .map(|asset| CorrelationAsset {
                    symbol: asset.symbol.clone(),
                    name: asset.name.clone(),
                })
                .collect(),
            values: correlation_values,
        },
        trades: ledger.trades,
        cash_flows: applied_flows,
        target_weight_schedule: applied_target_schedule,
        dividends: ledger.dividends,
        execution: input.execution.clone(),
        data_quality: DataQuality {
            alignment_policy: "carry_forward_for_valuation".into(),
            common_return_policy: "inner_join".into(),
            aligned_valuation_days: aligned.len(),
            common_return_observations: common_observations,
            carry_forward_by_asset: input
                .assets
                .iter()
                .enumerate()
                .map(|(index, asset)| CarryForward {
                    symbol: asset.symbol.clone(),
                    count: carry_forward[index],
                })
                .collect(),
            benchmark_carry_forward_count: benchmark_carry_forward,
            dividend_status: match input.realism.dividend_mode {
                DividendMode::AdjustedPriceOnly => "adjusted_price_policy".into(),
                DividendMode::Cash
                    if series_by_asset
                        .iter()
                        .any(|series| series.iter().any(|point| point.cash_dividend.is_some())) =>
                {
                    "provider_supplied".into()
                }
                DividendMode::Cash => "unavailable".into(),
            },
            liquidity_status: if input.realism.costs.market_impact_coefficient == 0.0
                && input.realism.costs.max_participation_rate_percent.is_none()
            {
                "not_requested".into()
            } else if ledger.missing_liquidity_observations == 0 {
                "provider_supplied".into()
            } else {
                "partial_or_unavailable".into()
            },
            liquidity_trade_observations: ledger.liquidity_observations,
            missing_liquidity_observations: ledger.missing_liquidity_observations,
            point_in_time_universe_status: if input.realism.enforce_point_in_time_universe {
                "explicit_input_enforced".into()
            } else {
                "not_enforced".into()
            },
            warnings: {
                let mut warnings = Vec::new();
                if input.realism.dividend_mode == DividendMode::Cash
                    && !series_by_asset
                        .iter()
                        .any(|series| series.iter().any(|point| point.cash_dividend.is_some()))
                {
                    warnings.push(
                        "현금 배당 모드가 요청됐지만 공급자 배당 데이터가 없어 배당을 0으로 추정하지 않고 unavailable로 표시했습니다."
                            .into(),
                    );
                }
                if ledger.missing_liquidity_observations > 0 {
                    warnings.push(format!(
                        "{}회의 거래 비용 계산에서 공급자 거래량이 없어 시장충격을 적용하지 않았습니다.",
                        ledger.missing_liquidity_observations
                    ));
                }
                if !input.realism.enforce_point_in_time_universe {
                    warnings.push(
                        "point-in-time universe가 강제되지 않아 상장폐지·편입 이력 기반 생존편향 보정은 보장되지 않습니다."
                            .into(),
                    );
                } else {
                    warnings.push(
                        "point-in-time universe는 요청에 명시된 [편입일, 제외일)과 상장폐지일을 사용했으며 공급자 원천 이력으로 추정하거나 검증하지 않았습니다."
                            .into(),
                    );
                }
                warnings
            },
        },
        advanced,
    };
    ensure!(
        serde_json::to_value(&result)?
            .to_string()
            .find("null")
            .is_some()
            || result.metrics.final_balance.is_finite(),
        "결과 직렬화에 실패했습니다."
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

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
                anyhow::bail!("TEST_BACKTEST_CANCELLED");
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

    fn fixture(
        quantity_mode: QuantityMode,
        cost_bps: f64,
        cash_target: f64,
    ) -> BacktestSimulationInput {
        let asset = AssetDefinition {
            symbol: "AAA".into(),
            name: "AAA".into(),
            market: "KR".into(),
            currency: "KRW".into(),
            list_date: "2020-01-01".into(),
            weight: 100.0 - cash_target,
            lot_size: 1.0,
            delist_date: None,
            universe_member_from: None,
            universe_member_to: None,
        };
        BacktestSimulationInput {
            assets: vec![asset],
            prices: BTreeMap::from([(
                "KRW:AAA".into(),
                vec![
                    PricePoint {
                        date: "2024-01-02".into(),
                        close: 300.0,
                        local_close: Some(300.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                    PricePoint {
                        date: "2024-01-03".into(),
                        close: 300.0,
                        local_close: Some(300.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                ],
            )]),
            observed_dates: BTreeMap::new(),
            requested_start_date: "2024-01-02".into(),
            end_date: "2024-01-03".into(),
            initial_amount: 1_000.0,
            monthly_cash_flow: 0.0,
            cash_flow_frequency: CashFlowFrequency::Monthly,
            cash_flow_timing: CashFlowTiming::PeriodStart,
            rebalance_frequency: RebalanceFrequency::None,
            risk_free_rate_percent: 0.0,
            transaction_cost_bps: cost_bps,
            rebalance_threshold_percent: 5.0,
            cash_flows: vec![],
            execution: ExecutionPolicy {
                cash_target_percent: cash_target,
                quantity_mode,
                ..ExecutionPolicy::default()
            },
            realism: RealismPolicy::default(),
            target_weight_schedule: vec![],
            benchmark: None,
        }
    }

    #[test]
    fn whole_shares_deduct_initial_cost_and_keep_cash() {
        let result = simulate(&fixture(QuantityMode::Whole, 100.0, 0.0)).unwrap();
        assert_eq!(result.trades[0].quantity, 3.0);
        assert_eq!(result.trades[0].amount, 900.0);
        assert_eq!(result.trades[0].transaction_cost, 9.0);
        assert_eq!(result.metrics.ending_cash_balance, 91.0);
        assert_eq!(result.metrics.final_balance, 991.0);
        assert_eq!(result.metrics.total_transaction_costs, 9.0);
    }

    #[test]
    fn cooperative_control_preserves_results_and_stops_inside_ledger_loop() {
        let input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        assert_eq!(
            serde_json::to_value(simulate_with_control(&input, Some(&NeverStop)).unwrap()).unwrap(),
            serde_json::to_value(simulate(&input).unwrap()).unwrap()
        );
        let control = StopAfter {
            remaining: AtomicUsize::new(2),
        };
        assert!(
            simulate_with_control(&input, Some(&control))
                .unwrap_err()
                .to_string()
                .contains("TEST_BACKTEST_CANCELLED")
        );
    }

    #[test]
    fn equity_points_are_not_truncated_above_1200_rows() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        let points = (0..1_305)
            .map(|index| {
                let date = crate::date::add_days("2020-01-01", index).unwrap();
                PricePoint {
                    date,
                    close: 100.0 + index as f64 * 0.01,
                    local_close: Some(100.0 + index as f64 * 0.01),
                    fx_rate: Some(1.0),
                    volume: None,
                    cash_dividend: None,
                }
            })
            .collect::<Vec<_>>();
        input.requested_start_date = points[0].date.clone();
        input.end_date = points.last().unwrap().date.clone();
        input.prices.insert("KRW:AAA".into(), points);

        let result = simulate(&input).unwrap();

        assert_eq!(result.points.len(), 1_305);
        assert_eq!(result.points[0].date, input.requested_start_date);
        assert_eq!(result.points.last().unwrap().date, input.end_date);
        assert_eq!(
            result.points.last().unwrap().balance,
            result.metrics.final_balance
        );
    }

    #[test]
    fn whole_shares_preserve_residual_above_cash_target() {
        let result = simulate(&fixture(QuantityMode::Whole, 0.0, 20.0)).unwrap();
        assert_eq!(result.trades[0].quantity, 2.0);
        assert_eq!(result.metrics.ending_cash_balance, 400.0);
        assert_eq!(result.metrics.final_balance, 1_000.0);
    }

    #[test]
    fn dated_target_schedule_rebalances_through_the_real_ledger() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.assets[0].weight = 50.0;
        input.assets.push(AssetDefinition {
            symbol: "BBB".into(),
            name: "BBB".into(),
            market: "KR".into(),
            currency: "KRW".into(),
            list_date: "2020-01-01".into(),
            weight: 50.0,
            lot_size: 1.0,
            delist_date: None,
            universe_member_from: None,
            universe_member_to: None,
        });
        input.prices.insert(
            "KRW:BBB".into(),
            vec![
                PricePoint {
                    date: "2024-01-02".into(),
                    close: 100.0,
                    local_close: Some(100.0),
                    fx_rate: Some(1.0),
                    volume: None,
                    cash_dividend: None,
                },
                PricePoint {
                    date: "2024-01-03".into(),
                    close: 100.0,
                    local_close: Some(100.0),
                    fx_rate: Some(1.0),
                    volume: None,
                    cash_dividend: None,
                },
            ],
        );
        input
            .target_weight_schedule
            .push(TargetWeightScheduleEntry {
                date: "2024-01-03".into(),
                weights: BTreeMap::from([("AAA".into(), 0.0), ("BBB".into(), 100.0)]),
                cash_target_percent: 0.0,
                regime: Some("risk_off".into()),
                action: Some("minimum_variance".into()),
            });

        let result = simulate(&input).unwrap();
        assert_eq!(result.target_weight_schedule.len(), 1);
        assert_eq!(
            result.target_weight_schedule[0].effective_date,
            "2024-01-03"
        );
        assert_eq!(
            result.target_weight_schedule[0].regime.as_deref(),
            Some("risk_off")
        );
        assert!(
            result
                .trades
                .iter()
                .any(|trade| trade.trigger == "regime_policy" && trade.symbol == "AAA")
        );
        assert!(
            result
                .trades
                .iter()
                .any(|trade| trade.trigger == "regime_policy" && trade.symbol == "BBB")
        );
        assert!((result.metrics.final_balance - 1_000.0).abs() < 1e-8);
        assert!(result.metrics.ending_cash_balance.abs() < 1e-8);
    }

    #[test]
    fn explicit_point_in_time_membership_changes_the_investable_ledger() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.assets[0].weight = 50.0;
        input.assets[0].universe_member_from = Some("2020-01-01".into());
        input.assets[0].universe_member_to = Some("2025-01-01".into());
        input.assets.push(AssetDefinition {
            symbol: "BBB".into(),
            name: "BBB".into(),
            market: "KR".into(),
            currency: "KRW".into(),
            list_date: "2024-01-03".into(),
            weight: 50.0,
            lot_size: 1.0,
            delist_date: None,
            universe_member_from: Some("2024-01-03".into()),
            universe_member_to: Some("2025-01-01".into()),
        });
        input.prices.insert(
            "KRW:BBB".into(),
            vec![PricePoint {
                date: "2024-01-03".into(),
                close: 100.0,
                local_close: Some(100.0),
                fx_rate: Some(1.0),
                volume: None,
                cash_dividend: None,
            }],
        );
        input.realism.enforce_point_in_time_universe = true;

        let result = simulate(&input).unwrap();
        assert_eq!(result.effective_start_date, "2024-01-02");
        assert_eq!(
            result.data_quality.point_in_time_universe_status,
            "explicit_input_enforced"
        );
        assert!(result.trades.iter().any(|trade| {
            trade.trigger == "point_in_time_universe"
                && trade.symbol == "BBB"
                && trade.side == "BUY"
        }));
        let ending = result
            .contributions
            .iter()
            .map(|item| (item.symbol.as_str(), item.ending_value))
            .collect::<BTreeMap<_, _>>();
        assert!((ending["AAA"] - 500.0).abs() < 1e-8);
        assert!((ending["BBB"] - 500.0).abs() < 1e-8);
        assert!((result.metrics.final_balance - 1_000.0).abs() < 1e-8);
    }

    #[test]
    fn custom_flow_is_xirr_input_and_does_not_change_flat_nav() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.cash_flows.push(CustomCashFlow {
            date: "2024-01-03".into(),
            amount: 100.0,
            memo: Some("deposit".into()),
        });
        let result = simulate(&input).unwrap();
        assert!((result.points[0].unit_price - result.points[1].unit_price).abs() < 1e-8);
        assert_eq!(result.metrics.final_balance, 1_100.0);
        assert_eq!(result.cash_flows[0].effective_date, "2024-01-03");
    }

    #[test]
    fn historical_fx_is_part_of_krw_path_and_attribution() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.prices.insert(
            "KRW:AAA".into(),
            vec![
                PricePoint {
                    date: "2024-01-02".into(),
                    close: 1_000.0,
                    local_close: Some(10.0),
                    fx_rate: Some(100.0),
                    volume: None,
                    cash_dividend: None,
                },
                PricePoint {
                    date: "2024-01-03".into(),
                    close: 1_200.0,
                    local_close: Some(10.0),
                    fx_rate: Some(120.0),
                    volume: None,
                    cash_dividend: None,
                },
            ],
        );
        let result = simulate(&input).unwrap();
        assert_eq!(result.metrics.final_balance, 1_200.0);
        assert_eq!(result.metrics.comparable.total_return_percent, 20.0);
        assert_eq!(
            result.contributions[0].local_price_contribution_percent,
            0.0
        );
        assert_eq!(result.contributions[0].fx_contribution_percent, 20.0);
    }

    #[test]
    fn mixed_same_day_flows_keep_gross_totals_and_xirr_inputs() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.cash_flows = vec![
            CustomCashFlow {
                date: "2024-01-03".into(),
                amount: 100.0,
                memo: Some("deposit".into()),
            },
            CustomCashFlow {
                date: "2024-01-03".into(),
                amount: -100.0,
                memo: Some("withdrawal".into()),
            },
        ];
        let result = simulate(&input).unwrap();
        assert_eq!(result.metrics.total_contributions, 1_100.0);
        assert_eq!(result.metrics.total_withdrawals, 100.0);
        assert_eq!(result.metrics.final_balance, 1_000.0);
        assert_eq!(result.metrics.money_weighted_return_percent, Some(0.0));
        assert_eq!(result.cash_flows.len(), 2);
    }

    #[test]
    fn contribution_preserves_configured_cash_target() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 20.0);
        input.cash_flows.push(CustomCashFlow {
            date: "2024-01-03".into(),
            amount: 100.0,
            memo: None,
        });
        let result = simulate(&input).unwrap();
        assert_eq!(result.metrics.final_balance, 1_100.0);
        assert_eq!(result.metrics.invested_balance, 880.0);
        assert_eq!(result.metrics.ending_cash_balance, 220.0);
        assert_eq!(result.metrics.ending_cash_weight_percent, 20.0);
    }

    #[test]
    fn withdrawal_sells_holdings_and_deducts_trade_cost() {
        let mut input = fixture(QuantityMode::Fractional, 100.0, 0.0);
        input.cash_flows.push(CustomCashFlow {
            date: "2024-01-03".into(),
            amount: -100.0,
            memo: None,
        });
        let result = simulate(&input).unwrap();
        let withdrawal_trade = result
            .trades
            .iter()
            .find(|trade| trade.side == "SELL")
            .unwrap();
        assert_eq!(withdrawal_trade.trigger, "cash_flow_rebalance");
        assert!(withdrawal_trade.transaction_cost > 0.0);
        assert_eq!(result.metrics.total_withdrawals, 100.0);
        assert_eq!(result.metrics.ending_cash_balance, 0.0);
        assert!(result.metrics.total_transaction_costs > 9.9);
    }

    fn two_asset_fixture() -> BacktestSimulationInput {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.assets = vec![
            AssetDefinition {
                symbol: "AAA".into(),
                name: "AAA".into(),
                market: "KR".into(),
                currency: "KRW".into(),
                list_date: "2020-01-01".into(),
                weight: 50.0,
                lot_size: 1.0,
                delist_date: None,
                universe_member_from: None,
                universe_member_to: None,
            },
            AssetDefinition {
                symbol: "BBB".into(),
                name: "BBB".into(),
                market: "KR".into(),
                currency: "KRW".into(),
                list_date: "2020-01-01".into(),
                weight: 50.0,
                lot_size: 1.0,
                delist_date: None,
                universe_member_from: None,
                universe_member_to: None,
            },
        ];
        input.prices = BTreeMap::from([
            (
                "KRW:AAA".into(),
                vec![
                    PricePoint {
                        date: "2024-01-02".into(),
                        close: 100.0,
                        local_close: Some(100.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                    PricePoint {
                        date: "2024-01-03".into(),
                        close: 200.0,
                        local_close: Some(200.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                    PricePoint {
                        date: "2024-01-04".into(),
                        close: 200.0,
                        local_close: Some(200.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                ],
            ),
            (
                "KRW:BBB".into(),
                vec![
                    PricePoint {
                        date: "2024-01-02".into(),
                        close: 100.0,
                        local_close: Some(100.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                    PricePoint {
                        date: "2024-01-03".into(),
                        close: 100.0,
                        local_close: Some(100.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                    PricePoint {
                        date: "2024-01-04".into(),
                        close: 100.0,
                        local_close: Some(100.0),
                        fx_rate: Some(1.0),
                        volume: None,
                        cash_dividend: None,
                    },
                ],
            ),
        ]);
        input.end_date = "2024-01-04".into();
        input
    }

    #[test]
    fn threshold_rebalance_trades_back_to_target() {
        let mut input = two_asset_fixture();
        input.rebalance_frequency = RebalanceFrequency::Threshold;
        input.rebalance_threshold_percent = 5.0;
        let result = simulate(&input).unwrap();
        let threshold_trades = result
            .trades
            .iter()
            .filter(|trade| trade.trigger == "threshold_rebalance")
            .collect::<Vec<_>>();
        assert_eq!(threshold_trades.len(), 2);
        assert_eq!(threshold_trades[0].side, "SELL");
        assert_eq!(threshold_trades[1].side, "BUY");
        assert!((result.metrics.ending_cash_weight_percent).abs() < 1e-8);
    }

    #[test]
    fn custom_flow_waits_for_next_common_observation() {
        let mut input = two_asset_fixture();
        input.prices.get_mut("KRW:BBB").unwrap().remove(1);
        input.cash_flows.push(CustomCashFlow {
            date: "2024-01-03".into(),
            amount: 100.0,
            memo: None,
        });
        let result = simulate(&input).unwrap();
        assert_eq!(result.cash_flows[0].scheduled_date, "2024-01-03");
        assert_eq!(result.cash_flows[0].effective_date, "2024-01-04");
        assert_eq!(result.data_quality.carry_forward_by_asset[1].count, 1);
    }

    #[test]
    fn fx_only_valuation_moves_krw_path_without_becoming_a_trade_day() {
        let mut input = two_asset_fixture();
        input.prices.insert(
            "KRW:AAA".into(),
            vec![
                PricePoint {
                    date: "2024-01-02".into(),
                    close: 100.0,
                    local_close: Some(100.0),
                    fx_rate: Some(1.0),
                    volume: None,
                    cash_dividend: None,
                },
                PricePoint {
                    date: "2024-01-03".into(),
                    close: 120.0,
                    local_close: Some(100.0),
                    fx_rate: Some(1.2),
                    volume: None,
                    cash_dividend: None,
                },
                PricePoint {
                    date: "2024-01-04".into(),
                    close: 132.0,
                    local_close: Some(110.0),
                    fx_rate: Some(1.2),
                    volume: None,
                    cash_dividend: None,
                },
            ],
        );
        input.observed_dates.insert(
            "KRW:AAA".into(),
            vec!["2024-01-02".into(), "2024-01-04".into()],
        );
        input.cash_flows.push(CustomCashFlow {
            date: "2024-01-03".into(),
            amount: 100.0,
            memo: None,
        });
        let result = simulate(&input).unwrap();
        assert!(result.points[1].balance > result.points[0].balance);
        assert_eq!(result.cash_flows[0].effective_date, "2024-01-04");
        assert_eq!(result.data_quality.carry_forward_by_asset[0].count, 1);
    }

    #[test]
    fn cash_position_accrues_configured_yield() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 100.0);
        input.prices.insert(
            "KRW:AAA".into(),
            vec![
                PricePoint {
                    date: "2024-01-02".into(),
                    close: 300.0,
                    local_close: Some(300.0),
                    fx_rate: Some(1.0),
                    volume: None,
                    cash_dividend: None,
                },
                PricePoint {
                    date: "2025-01-02".into(),
                    close: 300.0,
                    local_close: Some(300.0),
                    fx_rate: Some(1.0),
                    volume: None,
                    cash_dividend: None,
                },
            ],
        );
        input.end_date = "2025-01-02".into();
        input.execution.cash_annual_yield_percent = 10.0;
        let result = simulate(&input).unwrap();
        assert!(result.metrics.final_balance > 1_099.0);
        assert_eq!(result.metrics.invested_balance, 0.0);
        assert_eq!(result.metrics.ending_cash_weight_percent, 100.0);
    }

    #[test]
    fn explicit_dividend_is_taxed_once_and_preserves_flat_price_ledger() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.realism.dividend_mode = DividendMode::Cash;
        input.realism.costs.dividend_tax_bps = 1_500.0;
        input.prices.get_mut("KRW:AAA").unwrap()[1].cash_dividend = Some(30.0);

        let result = simulate(&input).unwrap();

        assert_eq!(result.dividends.len(), 1);
        assert_eq!(result.metrics.total_dividend_income, 100.0);
        assert_eq!(result.metrics.total_dividend_taxes, 15.0);
        assert_eq!(result.metrics.final_balance, 1_085.0);
        assert_eq!(result.data_quality.dividend_status, "provider_supplied");
    }

    #[test]
    fn volume_cap_and_market_impact_use_only_provider_observations() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.realism.costs.market_impact_coefficient = 0.01;
        input.realism.costs.max_participation_rate_percent = Some(10.0);
        input.prices.get_mut("KRW:AAA").unwrap()[0].volume = Some(10.0);

        let result = simulate(&input).unwrap();

        assert_eq!(result.trades[0].quantity, 1.0);
        assert_eq!(result.trades[0].participation_rate_percent, Some(10.0));
        assert!(result.trades[0].market_impact_cost > 0.0);
        assert_eq!(result.data_quality.missing_liquidity_observations, 0);
    }

    #[test]
    fn absent_volume_is_reported_and_market_impact_is_not_fabricated() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.realism.costs.market_impact_coefficient = 0.01;

        let result = simulate(&input).unwrap();

        assert_eq!(result.trades[0].market_impact_cost, 0.0);
        assert_eq!(
            result.data_quality.liquidity_status,
            "partial_or_unavailable"
        );
        assert!(
            result
                .data_quality
                .warnings
                .iter()
                .any(|warning| warning.contains("거래량"))
        );
    }

    #[test]
    fn point_in_time_enforcement_rejects_missing_membership_instead_of_guessing() {
        let mut input = fixture(QuantityMode::Fractional, 0.0, 0.0);
        input.realism.enforce_point_in_time_universe = true;

        assert!(
            simulate(&input)
                .unwrap_err()
                .to_string()
                .contains("point-in-time universe")
        );
    }
}
