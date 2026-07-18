use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn default_lot_size() -> f64 {
    1.0
}
fn default_cash_flow_frequency() -> CashFlowFrequency {
    CashFlowFrequency::Monthly
}
fn default_cash_flow_timing() -> CashFlowTiming {
    CashFlowTiming::PeriodStart
}
fn default_rebalance_frequency() -> RebalanceFrequency {
    RebalanceFrequency::None
}
fn default_quantity_mode() -> QuantityMode {
    QuantityMode::Fractional
}
fn default_cash_flow_rebalance_mode() -> CashFlowRebalanceMode {
    CashFlowRebalanceMode::TargetWeights
}
fn default_trade_date_policy() -> TradeDatePolicy {
    TradeDatePolicy::NextCommonObservation
}
fn default_threshold() -> f64 {
    5.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDefinition {
    pub symbol: String,
    pub name: String,
    pub market: String,
    pub currency: String,
    pub list_date: String,
    pub weight: f64,
    #[serde(default = "default_lot_size")]
    pub lot_size: f64,
    /// Optional provider supplied delisting date. It is deliberately not inferred
    /// from the final price observation.
    #[serde(default)]
    pub delist_date: Option<String>,
    /// Point-in-time universe membership bounds. When point-in-time enforcement
    /// is requested both values must be supplied by the caller/provider.
    #[serde(default)]
    pub universe_member_from: Option<String>,
    #[serde(default)]
    pub universe_member_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricePoint {
    pub date: String,
    pub close: f64,
    #[serde(default)]
    pub local_close: Option<f64>,
    #[serde(default)]
    pub fx_rate: Option<f64>,
    /// Provider supplied daily volume. None means unavailable; the engine never
    /// fabricates volume for market-impact calculations.
    #[serde(default)]
    pub volume: Option<f64>,
    /// Cash dividend per share in the portfolio base currency. Applied only when
    /// `realism.dividendMode` is `cash` so adjusted prices are not double-counted.
    #[serde(default)]
    pub cash_dividend: Option<f64>,
}

fn default_impact_exponent() -> f64 {
    0.5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionCostModel {
    /// None preserves the legacy `transactionCostBps` behavior.
    #[serde(default)]
    pub commission_bps: Option<f64>,
    #[serde(default)]
    pub sell_tax_bps: f64,
    #[serde(default)]
    pub fixed_slippage_bps: f64,
    /// Square-root style market impact coefficient as a fraction of price at
    /// 100% participation (0.01 = 1%).
    #[serde(default)]
    pub market_impact_coefficient: f64,
    #[serde(default = "default_impact_exponent")]
    pub market_impact_exponent: f64,
    #[serde(default)]
    pub max_participation_rate_percent: Option<f64>,
    #[serde(default)]
    pub minimum_fee: f64,
    #[serde(default)]
    pub dividend_tax_bps: f64,
}

impl Default for TransactionCostModel {
    fn default() -> Self {
        Self {
            commission_bps: None,
            sell_tax_bps: 0.0,
            fixed_slippage_bps: 0.0,
            market_impact_coefficient: 0.0,
            market_impact_exponent: default_impact_exponent(),
            max_participation_rate_percent: None,
            minimum_fee: 0.0,
            dividend_tax_bps: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DividendMode {
    /// Default for backward compatibility: assume supplied closes already
    /// represent the provider's total-return/adjustment policy.
    #[default]
    AdjustedPriceOnly,
    /// Apply explicit `cashDividend` observations to the ledger.
    Cash,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RealismPolicy {
    #[serde(default)]
    pub costs: TransactionCostModel,
    #[serde(default)]
    pub dividend_mode: DividendMode,
    #[serde(default)]
    pub enforce_point_in_time_universe: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkDefinition {
    pub key: String,
    pub name: String,
    pub prices: Vec<PricePoint>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CashFlowFrequency {
    Monthly,
    Quarterly,
    Annually,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CashFlowTiming {
    PeriodStart,
    PeriodEnd,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RebalanceFrequency {
    None,
    Monthly,
    Quarterly,
    Annually,
    Threshold,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuantityMode {
    Fractional,
    Whole,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CashFlowRebalanceMode {
    TargetWeights,
    DriftReduction,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TradeDatePolicy {
    NextCommonObservation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCashFlow {
    pub date: String,
    pub amount: f64,
    #[serde(default)]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetWeightScheduleEntry {
    pub date: String,
    /// Percent weights keyed by asset symbol. Every configured asset must be
    /// present so a policy cannot silently inherit a stale target.
    pub weights: BTreeMap<String, f64>,
    #[serde(default)]
    pub cash_target_percent: f64,
    #[serde(default)]
    pub regime: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedTargetWeightSchedule {
    pub scheduled_date: String,
    pub effective_date: String,
    pub weights: BTreeMap<String, f64>,
    pub cash_target_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPolicy {
    #[serde(default)]
    pub cash_target_percent: f64,
    #[serde(default = "default_quantity_mode")]
    pub quantity_mode: QuantityMode,
    #[serde(default = "default_cash_flow_rebalance_mode")]
    pub cash_flow_rebalance_mode: CashFlowRebalanceMode,
    #[serde(default = "default_trade_date_policy")]
    pub trade_date_policy: TradeDatePolicy,
    #[serde(default)]
    pub cash_annual_yield_percent: f64,
}

impl Default for ExecutionPolicy {
    fn default() -> Self {
        Self {
            cash_target_percent: 0.0,
            quantity_mode: default_quantity_mode(),
            cash_flow_rebalance_mode: default_cash_flow_rebalance_mode(),
            trade_date_policy: default_trade_date_policy(),
            cash_annual_yield_percent: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestSimulationInput {
    pub assets: Vec<AssetDefinition>,
    pub prices: BTreeMap<String, Vec<PricePoint>>,
    #[serde(default)]
    pub observed_dates: BTreeMap<String, Vec<String>>,
    pub requested_start_date: String,
    pub end_date: String,
    pub initial_amount: f64,
    #[serde(default)]
    pub monthly_cash_flow: f64,
    #[serde(default = "default_cash_flow_frequency")]
    pub cash_flow_frequency: CashFlowFrequency,
    #[serde(default = "default_cash_flow_timing")]
    pub cash_flow_timing: CashFlowTiming,
    #[serde(default = "default_rebalance_frequency")]
    pub rebalance_frequency: RebalanceFrequency,
    #[serde(default)]
    pub risk_free_rate_percent: f64,
    #[serde(default)]
    pub transaction_cost_bps: f64,
    #[serde(default = "default_threshold")]
    pub rebalance_threshold_percent: f64,
    #[serde(default)]
    pub cash_flows: Vec<CustomCashFlow>,
    #[serde(default)]
    pub target_weight_schedule: Vec<TargetWeightScheduleEntry>,
    #[serde(default)]
    pub execution: ExecutionPolicy,
    #[serde(default)]
    pub realism: RealismPolicy,
    #[serde(default)]
    pub benchmark: Option<BenchmarkDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestPoint {
    pub date: String,
    pub balance: f64,
    pub growth: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub benchmark_growth: Option<f64>,
    pub drawdown_percent: f64,
    pub cash_balance: f64,
    pub invested_balance: f64,
    pub unit_price: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparableMetrics {
    pub total_return_percent: f64,
    pub cagr_percent: Option<f64>,
    pub annualized_volatility_percent: Option<f64>,
    pub max_drawdown_percent: f64,
    pub max_drawdown_days: i64,
    pub sharpe_ratio: Option<f64>,
    pub sortino_ratio: Option<f64>,
    pub calmar_ratio: Option<f64>,
    pub best_daily_return_percent: Option<f64>,
    pub worst_daily_return_percent: Option<f64>,
    pub positive_days_percent: Option<f64>,
    pub best_year_percent: Option<f64>,
    pub worst_year_percent: Option<f64>,
    pub positive_months_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestMetrics {
    #[serde(flatten)]
    pub comparable: ComparableMetrics,
    pub final_balance: f64,
    pub total_contributions: f64,
    pub total_withdrawals: f64,
    pub ending_cash_balance: f64,
    pub ending_cash_weight_percent: f64,
    pub invested_balance: f64,
    pub total_transaction_costs: f64,
    pub total_dividend_income: f64,
    pub total_dividend_taxes: f64,
    pub net_profit_loss: f64,
    pub money_weighted_return_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualReturn {
    pub year: i32,
    pub return_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeEvent {
    #[serde(skip_serializing)]
    pub asset_index: usize,
    pub date: String,
    pub symbol: String,
    pub side: String,
    pub amount: f64,
    pub quantity: f64,
    pub price: f64,
    pub reason: String,
    pub transaction_cost: f64,
    pub commission: f64,
    pub tax: f64,
    pub slippage_cost: f64,
    pub market_impact_cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participation_rate_percent: Option<f64>,
    pub net_cash_impact: f64,
    pub trigger: String,
    pub lot_size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividendEvent {
    pub date: String,
    pub symbol: String,
    pub quantity: f64,
    pub amount_per_share: f64,
    pub gross_amount: f64,
    pub tax: f64,
    pub net_amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCashFlow {
    pub scheduled_date: String,
    pub effective_date: String,
    pub amount: f64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub symbol: String,
    pub name: String,
    pub market: String,
    pub currency: String,
    pub weight: f64,
    pub ending_value: f64,
    pub profit_loss: f64,
    pub contribution_percent: f64,
    pub time_linked_contribution_percent: f64,
    pub local_price_contribution_percent: f64,
    pub fx_contribution_percent: f64,
    pub up_regime_contribution_percent: f64,
    pub down_regime_contribution_percent: f64,
    pub asset_return_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationAsset {
    pub symbol: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Correlations {
    pub assets: Vec<CorrelationAsset>,
    pub values: Vec<Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryForward {
    pub symbol: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataQuality {
    pub alignment_policy: String,
    pub common_return_policy: String,
    pub aligned_valuation_days: usize,
    pub common_return_observations: usize,
    pub carry_forward_by_asset: Vec<CarryForward>,
    pub benchmark_carry_forward_count: usize,
    pub dividend_status: String,
    pub liquidity_status: String,
    pub liquidity_trade_observations: usize,
    pub missing_liquidity_observations: usize,
    pub point_in_time_universe_status: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestSimulationResult {
    pub requested_start_date: String,
    pub effective_start_date: String,
    pub end_date: String,
    pub points: Vec<BacktestPoint>,
    pub metrics: BacktestMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub benchmark_metrics: Option<ComparableMetrics>,
    pub annual_returns: Vec<AnnualReturn>,
    pub contributions: Vec<Contribution>,
    pub correlations: Correlations,
    pub trades: Vec<TradeEvent>,
    pub cash_flows: Vec<AppliedCashFlow>,
    pub target_weight_schedule: Vec<AppliedTargetWeightSchedule>,
    pub dividends: Vec<DividendEvent>,
    pub execution: ExecutionPolicy,
    pub data_quality: DataQuality,
    pub advanced: Value,
}
