use std::cmp::Ordering;
use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

use crate::backtest;
use crate::control::{ComputeControl, checkpoint};
use crate::model::{BacktestSimulationInput, TargetWeightScheduleEntry};
use crate::portfolio_math::covariance_matrix;

use super::baseline::baseline_dense_weights;
use super::constraints::repair_dense_weights;
use super::ledger::{ledger_metrics, template_asset_index};
use super::rng::Mulberry32;
use super::{
    Constraints, Frame, OptimizerV2Config, Weights, mean, nullable, quantile_linear, sample_std,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RegimePolicyMethod {
    Auto,
    DynamicProgramming,
    Mcts,
}

impl RegimePolicyMethod {
    pub(super) fn parse(value: Option<&Value>) -> Result<Self> {
        match value
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "auto" => Ok(Self::Auto),
            "dynamic_programming" | "dp" => Ok(Self::DynamicProgramming),
            "mcts" | "uct_mcts" => Ok(Self::Mcts),
            value => bail!("unsupported regime policy search method: {value}"),
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::DynamicProgramming => "dynamic_programming",
            Self::Mcts => "mcts",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct RegimePolicyConfig {
    pub(super) requested_method: RegimePolicyMethod,
    pub(super) states: Vec<String>,
    pub(super) actions: Vec<String>,
    pub(super) lookback: usize,
    pub(super) rebalance_every: usize,
    pub(super) train_fraction: f64,
    pub(super) minimum_training_decisions: usize,
    pub(super) max_depth: usize,
    pub(super) rollouts: usize,
    pub(super) exploration_constant: f64,
    pub(super) discount: f64,
    pub(super) switching_cost_bps: f64,
    pub(super) ledger_validation_budget: usize,
}

#[derive(Debug, Clone)]
struct RegimeDecision {
    date: String,
    signal_cutoff_date: String,
    return_start: usize,
    return_end: usize,
    state: usize,
    risk_score: f64,
    momentum: f64,
    annualized_volatility: f64,
    action_weights: Vec<Weights>,
}

#[derive(Debug, Clone)]
struct RegimePolicyCandidate {
    id: String,
    name: String,
    source: String,
    policy: Vec<Vec<usize>>,
    training_actions: Vec<usize>,
    oos_actions: Vec<usize>,
    training_metrics: Value,
    oos_metrics: Value,
    screening_rank: usize,
    validation_status: String,
    validation_error: Option<String>,
    ledger_metrics: Option<Value>,
    ledger_robust_detail: Option<Value>,
    ledger_data_quality: Option<Value>,
    ledger_rank: Option<usize>,
    rank_change: Option<i64>,
}

fn regime_state_index(risk_score: f64, state_count: usize) -> usize {
    if state_count <= 1 {
        return 0;
    }
    let scaled = ((risk_score.clamp(-1.0, 1.0) + 1.0) * 0.5 * state_count as f64).floor();
    (scaled as usize).min(state_count - 1)
}

fn build_regime_decisions(
    frame: &Frame,
    config: &RegimePolicyConfig,
    optimizer_config: &OptimizerV2Config,
    constraints: &Constraints,
    control: Option<&dyn ComputeControl>,
) -> Result<(Vec<RegimeDecision>, Vec<String>, Vec<String>)> {
    if frame.returns.len() <= config.lookback || frame.ids.is_empty() {
        bail!(
            "regime policy search requires more than {} aligned return observations",
            config.lookback
        );
    }
    let mut provisional = Vec::<(
        String,
        String,
        usize,
        usize,
        usize,
        f64,
        f64,
        f64,
        Vec<Option<Weights>>,
    )>::new();
    let mut valid_actions = vec![true; config.actions.len()];
    for (decision_number, return_start) in (config.lookback..frame.returns.len())
        .step_by(config.rebalance_every)
        .enumerate()
    {
        if decision_number.is_multiple_of(8) {
            checkpoint(control)?;
        }
        let history_start = return_start - config.lookback;
        let history = Frame {
            ids: frame.ids.clone(),
            dates: frame.dates[history_start..return_start].to_vec(),
            returns: frame.returns[history_start..return_start].to_vec(),
        };
        let covariance = covariance_matrix(
            &history.returns,
            history.ids.len(),
            optimizer_config.covariance_estimator,
        );
        let action_weights = config
            .actions
            .iter()
            .enumerate()
            .map(|(action_index, action)| {
                let weights = baseline_dense_weights(action, &history, &covariance, constraints)
                    .and_then(|dense| {
                        repair_dense_weights(
                            &dense,
                            &frame.ids,
                            constraints,
                            &optimizer_config.group_constraints,
                            &optimizer_config.asset_groups,
                        )
                    });
                if weights.is_none() {
                    valid_actions[action_index] = false;
                }
                weights
            })
            .collect::<Vec<_>>();
        let market_returns = history
            .returns
            .iter()
            .map(|row| mean(row))
            .collect::<Vec<_>>();
        let momentum = market_returns
            .iter()
            .fold(1.0, |growth, value| growth * (1.0 + value))
            - 1.0;
        let deviation = sample_std(&market_returns);
        let risk_score = if deviation > 1e-14 {
            mean(&market_returns) / deviation * (market_returns.len() as f64).sqrt()
        } else if momentum > 0.0 {
            1.0
        } else if momentum < 0.0 {
            -1.0
        } else {
            0.0
        };
        provisional.push((
            frame.dates[return_start].clone(),
            frame.dates[return_start - 1].clone(),
            return_start,
            (return_start + config.rebalance_every).min(frame.returns.len()),
            regime_state_index(risk_score, config.states.len()),
            risk_score,
            momentum,
            deviation * 252.0_f64.sqrt(),
            action_weights,
        ));
    }
    let retained_indices = valid_actions
        .iter()
        .enumerate()
        .filter_map(|(index, valid)| (*valid).then_some(index))
        .collect::<Vec<_>>();
    if retained_indices.is_empty() {
        bail!("no baseline action satisfies the regime policy constraints at every decision");
    }
    let effective_actions = retained_indices
        .iter()
        .map(|index| config.actions[*index].clone())
        .collect::<Vec<_>>();
    let removed_actions = config
        .actions
        .iter()
        .enumerate()
        .filter_map(|(index, action)| (!valid_actions[index]).then_some(action.clone()))
        .collect::<Vec<_>>();
    let warnings = if removed_actions.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "일부 국면 결정일에서 제약을 만족하지 못한 baseline action을 제외했습니다: {}",
            removed_actions.join(", ")
        )]
    };
    let decisions = provisional
        .into_iter()
        .map(
            |(
                date,
                signal_cutoff_date,
                return_start,
                return_end,
                state,
                risk_score,
                momentum,
                annualized_volatility,
                action_weights,
            )| RegimeDecision {
                date,
                signal_cutoff_date,
                return_start,
                return_end,
                state,
                risk_score,
                momentum,
                annualized_volatility,
                action_weights: retained_indices
                    .iter()
                    .map(|index| {
                        action_weights[*index]
                            .clone()
                            .expect("retained actions are available at every decision")
                    })
                    .collect(),
            },
        )
        .collect();
    Ok((decisions, effective_actions, warnings))
}

#[derive(Debug, Clone)]
struct EmpiricalPolicyModel {
    rewards: Vec<Vec<f64>>,
    transitions: Vec<Vec<f64>>,
    switching_costs: Vec<Vec<f64>>,
}

fn interval_log_growth(frame: &Frame, decision: &RegimeDecision, weights: &Weights) -> f64 {
    let dense = weights.dense(&frame.ids);
    frame.returns[decision.return_start..decision.return_end]
        .iter()
        .map(|row| {
            row.iter()
                .zip(&dense)
                .map(|(value, weight)| value * weight)
                .sum::<f64>()
        })
        .map(|value| (1.0 + value).max(1e-12).ln())
        .sum()
}

fn build_empirical_policy_model(
    frame: &Frame,
    decisions: &[RegimeDecision],
    training_count: usize,
    state_count: usize,
    action_count: usize,
    switching_cost_bps: f64,
) -> (EmpiricalPolicyModel, Vec<String>) {
    let training = &decisions[..training_count];
    let mut reward_sums = vec![vec![0.0; action_count]; state_count];
    let mut state_observations = vec![0usize; state_count];
    let mut global_reward_sums = vec![0.0; action_count];
    for decision in training {
        state_observations[decision.state] += 1;
        for (action, weights) in decision.action_weights.iter().enumerate() {
            let reward = interval_log_growth(frame, decision, weights);
            reward_sums[decision.state][action] += reward;
            global_reward_sums[action] += reward;
        }
    }
    let global_denominator = training.len().max(1) as f64;
    let global_rewards = global_reward_sums
        .iter()
        .map(|value| value / global_denominator)
        .collect::<Vec<_>>();
    let rewards = (0..state_count)
        .map(|state| {
            if state_observations[state] == 0 {
                global_rewards.clone()
            } else {
                reward_sums[state]
                    .iter()
                    .map(|value| value / state_observations[state] as f64)
                    .collect()
            }
        })
        .collect::<Vec<Vec<f64>>>();

    // A tiny symmetric prior keeps never-observed transitions well-defined without using OOS data.
    let mut transition_counts = vec![vec![1e-6; state_count]; state_count];
    for pair in training.windows(2) {
        transition_counts[pair[0].state][pair[1].state] += 1.0;
    }
    let transitions = transition_counts
        .into_iter()
        .map(|row| {
            let total = row.iter().sum::<f64>().max(1e-18);
            row.into_iter().map(|value| value / total).collect()
        })
        .collect::<Vec<Vec<f64>>>();

    let mut switching_costs = vec![vec![0.0; action_count]; action_count];
    let pair_count = training.len().saturating_sub(1);
    if pair_count > 0 && switching_cost_bps > 0.0 {
        for pair in training.windows(2) {
            for (previous, previous_weights) in pair[0].action_weights.iter().enumerate() {
                let previous_dense = previous_weights.dense(&frame.ids);
                for (action, weights) in pair[1].action_weights.iter().enumerate() {
                    let dense = weights.dense(&frame.ids);
                    let turnover = 0.5
                        * previous_dense
                            .iter()
                            .zip(dense)
                            .map(|(left, right)| (left - right).abs())
                            .sum::<f64>();
                    let cost = turnover * switching_cost_bps / 10_000.0;
                    switching_costs[previous][action] += -(1.0 - cost).max(1e-12).ln();
                }
            }
        }
        for row in &mut switching_costs {
            for cost in row {
                *cost /= pair_count as f64;
            }
        }
    }
    let warnings = state_observations
        .iter()
        .enumerate()
        .filter(|(_, observations)| **observations == 0)
        .map(|(state, _)| {
            format!(
                "훈련 구간에서 국면 index {state} 관측이 없어 전체 훈련 평균 보상을 사용했습니다."
            )
        })
        .collect();
    (
        EmpiricalPolicyModel {
            rewards,
            transitions,
            switching_costs,
        },
        warnings,
    )
}

fn policy_reward(
    model: &EmpiricalPolicyModel,
    state: usize,
    previous_action: usize,
    action: usize,
) -> f64 {
    let switching_cost = if previous_action < model.switching_costs.len() {
        model.switching_costs[previous_action][action]
    } else {
        0.0
    };
    model.rewards[state][action] - switching_cost
}

fn dynamic_programming_policy(
    model: &EmpiricalPolicyModel,
    max_depth: usize,
    discount: f64,
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Vec<usize>>> {
    let state_count = model.rewards.len();
    let action_count = model.rewards.first().map(Vec::len).unwrap_or(0);
    let previous_action_count = action_count + 1;
    let mut values = vec![vec![0.0; previous_action_count]; state_count];
    let mut policy = vec![vec![0usize; previous_action_count]; state_count];
    for depth in 0..max_depth {
        if depth.is_multiple_of(4) {
            checkpoint(control)?;
        }
        let mut next_values = vec![vec![0.0; previous_action_count]; state_count];
        for state in 0..state_count {
            for previous in 0..previous_action_count {
                let mut best_action = 0usize;
                let mut best_value = f64::NEG_INFINITY;
                for (action, _) in model.rewards[state].iter().enumerate() {
                    let continuation = model.transitions[state]
                        .iter()
                        .enumerate()
                        .map(|(next_state, probability)| probability * values[next_state][action])
                        .sum::<f64>();
                    let value =
                        policy_reward(model, state, previous, action) + discount * continuation;
                    if value > best_value {
                        best_value = value;
                        best_action = action;
                    }
                }
                policy[state][previous] = best_action;
                next_values[state][previous] = best_value;
            }
        }
        values = next_values;
    }
    Ok(policy)
}

#[derive(Debug, Clone, Copy, Default)]
struct MctsActionStat {
    visits: u64,
    value_sum: f64,
}

fn sample_transition(probabilities: &[f64], rng: &mut Mulberry32) -> usize {
    let target = rng.next();
    let mut cumulative = 0.0;
    for (index, probability) in probabilities.iter().enumerate() {
        cumulative += probability;
        if target <= cumulative || index + 1 == probabilities.len() {
            return index;
        }
    }
    0
}

fn mcts_policy(
    model: &EmpiricalPolicyModel,
    max_depth: usize,
    rollouts: usize,
    exploration_constant: f64,
    discount: f64,
    rng: &mut Mulberry32,
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Vec<usize>>> {
    let state_count = model.rewards.len();
    let action_count = model.rewards.first().map(Vec::len).unwrap_or(0);
    let previous_action_count = action_count + 1;
    let mut policy = vec![vec![0usize; previous_action_count]; state_count];
    for (root_state, policy_by_previous) in policy.iter_mut().enumerate() {
        for (root_previous, selected_policy) in policy_by_previous.iter_mut().enumerate() {
            let mut tree = BTreeMap::<(usize, usize, usize), Vec<MctsActionStat>>::new();
            for rollout in 0..rollouts {
                if rollout.is_multiple_of(64) {
                    checkpoint(control)?;
                }
                let mut state = root_state;
                let mut previous = root_previous;
                let mut path = Vec::<((usize, usize, usize), usize, f64)>::new();
                for depth in 0..max_depth {
                    let key = (depth, state, previous);
                    let stats = tree
                        .entry(key)
                        .or_insert_with(|| vec![MctsActionStat::default(); action_count]);
                    let total_visits = stats.iter().map(|stat| stat.visits).sum::<u64>();
                    let action = stats
                        .iter()
                        .position(|stat| stat.visits == 0)
                        .unwrap_or_else(|| {
                            stats
                                .iter()
                                .enumerate()
                                .max_by(|(left_index, left), (right_index, right)| {
                                    let score = |stat: &MctsActionStat| {
                                        stat.value_sum / stat.visits as f64
                                            + exploration_constant
                                                * ((total_visits.max(1) as f64).ln()
                                                    / stat.visits as f64)
                                                    .sqrt()
                                    };
                                    score(left)
                                        .total_cmp(&score(right))
                                        .then_with(|| right_index.cmp(left_index))
                                })
                                .map(|(index, _)| index)
                                .unwrap_or(0)
                        });
                    let reward = policy_reward(model, state, previous, action);
                    path.push((key, action, reward));
                    state = sample_transition(&model.transitions[state], rng);
                    previous = action;
                }
                let mut return_from_node = 0.0;
                for (key, action, reward) in path.into_iter().rev() {
                    return_from_node = reward + discount * return_from_node;
                    let stat = &mut tree
                        .get_mut(&key)
                        .expect("visited MCTS node remains in the tree")[action];
                    stat.visits += 1;
                    stat.value_sum += return_from_node;
                }
            }
            let root = tree
                .get(&(0, root_state, root_previous))
                .context("MCTS did not visit its root node")?;
            *selected_policy = root
                .iter()
                .enumerate()
                .max_by(|(left_index, left), (right_index, right)| {
                    left.visits
                        .cmp(&right.visits)
                        .then_with(|| {
                            let left_mean = left.value_sum / left.visits.max(1) as f64;
                            let right_mean = right.value_sum / right.visits.max(1) as f64;
                            left_mean.total_cmp(&right_mean)
                        })
                        .then_with(|| right_index.cmp(left_index))
                })
                .map(|(index, _)| index)
                .unwrap_or(0);
        }
    }
    Ok(policy)
}

fn follow_regime_policy(
    policy: &[Vec<usize>],
    decisions: &[RegimeDecision],
    action_count: usize,
) -> Vec<usize> {
    let mut previous = action_count;
    decisions
        .iter()
        .map(|decision| {
            let action = policy[decision.state][previous];
            previous = action;
            action
        })
        .collect()
}

fn constant_regime_policy(
    state_count: usize,
    action_count: usize,
    action: usize,
) -> Vec<Vec<usize>> {
    vec![vec![action; action_count + 1]; state_count]
}

fn policy_screening_metrics(
    frame: &Frame,
    decisions: &[RegimeDecision],
    actions: &[usize],
    annualization: f64,
    risk_free_percent: f64,
    transaction_cost_bps: f64,
) -> Value {
    let mut returns = Vec::<f64>::new();
    let mut dates = Vec::<String>::new();
    let mut previous_weights: Option<Vec<f64>> = None;
    let mut total_turnover = 0.0;
    let mut total_transaction_cost = 0.0;
    for (decision, action) in decisions.iter().zip(actions) {
        let dense = decision.action_weights[*action].dense(&frame.ids);
        let transaction_cost = previous_weights
            .as_ref()
            .map(|previous| {
                let turnover = 0.5
                    * previous
                        .iter()
                        .zip(&dense)
                        .map(|(left, right)| (left - right).abs())
                        .sum::<f64>();
                total_turnover += turnover;
                turnover * transaction_cost_bps / 10_000.0
            })
            .unwrap_or(0.0);
        total_transaction_cost += transaction_cost;
        for return_index in decision.return_start..decision.return_end {
            let mut portfolio_return = frame.returns[return_index]
                .iter()
                .zip(&dense)
                .map(|(value, weight)| value * weight)
                .sum::<f64>();
            if return_index == decision.return_start && transaction_cost > 0.0 {
                portfolio_return = (1.0 - transaction_cost) * (1.0 + portfolio_return) - 1.0;
            }
            returns.push(portfolio_return);
            dates.push(frame.dates[return_index].clone());
        }
        previous_weights = Some(dense);
    }
    let observations = returns.len();
    let cumulative = returns
        .iter()
        .fold(1.0, |growth, value| growth * (1.0 + value))
        - 1.0;
    let elapsed_years = dates
        .first()
        .zip(dates.last())
        .map(|(first, last)| {
            let days = crate::date::days_between(first, last);
            (1.0 / annualization).max((days as f64 + 365.25 / annualization) / 365.25)
        })
        .unwrap_or(0.0);
    let cagr = if 1.0 + cumulative > 0.0 && elapsed_years > 0.0 {
        (1.0 + cumulative).powf(1.0 / elapsed_years) - 1.0
    } else {
        f64::NAN
    };
    let deviation = sample_std(&returns);
    let volatility = (observations >= 2).then_some(deviation * annualization.sqrt());
    let risk_free_period = (1.0 + risk_free_percent / 100.0).powf(1.0 / annualization) - 1.0;
    let excess_mean = mean(
        &returns
            .iter()
            .map(|value| value - risk_free_period)
            .collect::<Vec<_>>(),
    );
    let sharpe = (deviation > 1e-14).then_some(excess_mean * annualization.sqrt() / deviation);
    let downside = if returns.is_empty() {
        0.0
    } else {
        (returns
            .iter()
            .map(|value| (value - risk_free_period).min(0.0).powi(2))
            .sum::<f64>()
            / returns.len() as f64)
            .sqrt()
    };
    let sortino = (downside > 1e-14).then_some(excess_mean * annualization.sqrt() / downside);
    let mut growth = 1.0;
    let mut peak: f64 = 1.0;
    let mut max_drawdown = 0.0_f64;
    for value in &returns {
        growth *= 1.0 + value;
        peak = peak.max(growth);
        max_drawdown = max_drawdown.min(growth / peak - 1.0);
    }
    let calmar = (max_drawdown < -1e-14 && cagr.is_finite()).then_some(cagr / max_drawdown.abs());
    let cvar = quantile_linear(&returns, 0.05).map(|threshold| {
        mean(
            &returns
                .iter()
                .copied()
                .filter(|value| *value <= threshold)
                .collect::<Vec<_>>(),
        )
    });
    let robust_components = [
        ("sharpe", sharpe.map(|value| (value / 2.0).tanh()), 0.30),
        ("sortino", sortino.map(|value| (value / 2.0).tanh()), 0.20),
        ("calmar", calmar.map(f64::tanh), 0.15),
        (
            "volatility",
            volatility.map(|value| 1.0 / (1.0 + value.max(0.0))),
            0.15,
        ),
        ("cvar", cvar.map(|value| 1.0 / (1.0 + value.abs())), 0.10),
        (
            "turnover",
            Some(1.0 / (1.0 + total_turnover.max(0.0))),
            0.10,
        ),
    ];
    let available_weight = robust_components
        .iter()
        .filter_map(|(_, value, weight)| value.map(|_| *weight))
        .sum::<f64>();
    let robust_score = (available_weight > 0.0).then(|| {
        robust_components
            .iter()
            .filter_map(|(_, value, weight)| value.map(|value| value * weight))
            .sum::<f64>()
            / available_weight
    });
    json!({
        "sampleCount": observations,
        "startDate": dates.first(),
        "endDate": dates.last(),
        "return": nullable(cumulative),
        "cagr": nullable(cagr),
        "volatility": volatility,
        "maxDrawdown": nullable(max_drawdown),
        "cvar": cvar,
        "sharpe": sharpe,
        "sortino": sortino,
        "calmar": calmar,
        "turnover": total_turnover,
        "transactionCost": total_transaction_cost,
        "robustScore": robust_score,
        "robustScoreDetail": {
            "score": robust_score,
            "configuredWeight": 1.0,
            "availableWeight": available_weight,
            "components": robust_components.into_iter().map(|(name, normalized, weight)| json!({
                "name": name,
                "normalized": normalized,
                "weight": weight,
                "available": normalized.is_some(),
                "contribution": normalized.unwrap_or(0.0) * weight,
            })).collect::<Vec<_>>(),
        },
    })
}

fn policy_action_map_json(policy: &[Vec<usize>], states: &[String], actions: &[String]) -> Value {
    let start = actions.len();
    Value::Object(
        states
            .iter()
            .enumerate()
            .map(|(state_index, state)| {
                let mut by_previous = Map::new();
                by_previous.insert(
                    "__start__".to_owned(),
                    json!(actions[policy[state_index][start]]),
                );
                for (previous, previous_name) in actions.iter().enumerate() {
                    by_previous.insert(
                        previous_name.clone(),
                        json!(actions[policy[state_index][previous]]),
                    );
                }
                (state.clone(), Value::Object(by_previous))
            })
            .collect(),
    )
}

fn policy_trace_json(
    decisions: &[RegimeDecision],
    selected_actions: &[usize],
    states: &[String],
    actions: &[String],
) -> Vec<Value> {
    decisions
        .iter()
        .zip(selected_actions)
        .map(|(decision, action)| {
            json!({
                "date": decision.date,
                "signalCutoffDate": decision.signal_cutoff_date,
                "state": states[decision.state],
                "stateIndex": decision.state,
                "action": actions[*action],
                "signal": {
                    "riskAdjustedMomentum": decision.risk_score,
                    "momentum": decision.momentum,
                    "annualizedVolatility": decision.annualized_volatility,
                },
                "weights": decision.action_weights[*action].to_json(),
            })
        })
        .collect()
}

fn policy_weights_for_template(
    template: &BacktestSimulationInput,
    frame_ids: &[String],
    weights: &Weights,
    cash_target_percent: f64,
) -> Result<(Vec<f64>, BTreeMap<String, f64>)> {
    let mut by_index = vec![0.0; template.assets.len()];
    let dense = weights.dense(frame_ids);
    let total = dense.iter().sum::<f64>();
    if total <= 0.0 || total > 1.0 + 1e-8 {
        bail!("regime policy weights cannot be applied to ledger template");
    }
    let invested_percent = 100.0 - cash_target_percent;
    for (id, weight) in frame_ids.iter().zip(dense) {
        if weight <= 1e-14 {
            continue;
        }
        let index = template_asset_index(template, id)?;
        by_index[index] += weight / total * invested_percent;
    }
    let mut by_symbol = BTreeMap::new();
    for (index, asset) in template.assets.iter().enumerate() {
        if by_symbol
            .insert(asset.symbol.clone(), by_index[index])
            .is_some()
        {
            bail!("regime policy ledger validation requires unique asset symbols");
        }
    }
    Ok((by_index, by_symbol))
}

fn ledger_input_for_regime_policy(
    template: &Value,
    frame: &Frame,
    decisions: &[RegimeDecision],
    selected_actions: &[usize],
    states: &[String],
    actions: &[String],
) -> Result<BacktestSimulationInput> {
    let mut input: BacktestSimulationInput = serde_json::from_value(template.clone())
        .context("invalid ledgerTemplate backtest simulation input")?;
    let frame_end = frame
        .dates
        .last()
        .context("regime policy frame has no dates")?;
    if input.end_date > *frame_end {
        input.end_date = frame_end.clone();
    }
    let selected = decisions
        .iter()
        .zip(selected_actions)
        .filter(|(decision, _)| {
            decision.date >= input.requested_start_date && decision.date <= input.end_date
        })
        .collect::<Vec<_>>();
    let (first_decision, first_action) = selected
        .first()
        .copied()
        .context("no OOS regime decision falls inside the ledger template period")?;
    input.requested_start_date = first_decision.date.clone();
    let cash_target_percent = input.execution.cash_target_percent.clamp(0.0, 99.0);
    let (initial_weights, _) = policy_weights_for_template(
        &input,
        &frame.ids,
        &first_decision.action_weights[*first_action],
        cash_target_percent,
    )?;
    for (asset, weight) in input.assets.iter_mut().zip(initial_weights) {
        asset.weight = weight;
    }
    input.execution.cash_target_percent = cash_target_percent;
    input.target_weight_schedule = selected
        .into_iter()
        .map(|(decision, action)| {
            let (_, weights) = policy_weights_for_template(
                &input,
                &frame.ids,
                &decision.action_weights[*action],
                cash_target_percent,
            )?;
            Ok(TargetWeightScheduleEntry {
                date: decision.date.clone(),
                weights,
                cash_target_percent,
                regime: Some(states[decision.state].clone()),
                action: Some(actions[*action].clone()),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(input)
}

fn regime_policy_candidate_json(
    candidate: &RegimePolicyCandidate,
    states: &[String],
    actions: &[String],
    trace_preview: &[Value],
) -> Value {
    json!({
        "id": candidate.id,
        "name": candidate.name,
        "candidateSource": candidate.source,
        "statePreviousActionMap": policy_action_map_json(&candidate.policy, states, actions),
        "trainingMetrics": candidate.training_metrics,
        "oosScreeningMetrics": candidate.oos_metrics,
        "screeningRank": candidate.screening_rank,
        "ledgerValidationStatus": candidate.validation_status,
        "validationError": candidate.validation_error,
        "ledgerMetrics": candidate.ledger_metrics,
        "ledgerRobustScoreDetail": candidate.ledger_robust_detail,
        "ledgerDataQuality": candidate.ledger_data_quality,
        "ledgerRank": candidate.ledger_rank,
        "rankChange": candidate.rank_change,
        "decisionTracePreview": trace_preview,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_regime_policy_search(
    frame: &Frame,
    config: &RegimePolicyConfig,
    optimizer_config: &OptimizerV2Config,
    constraints: &Constraints,
    annualization: f64,
    risk_free_percent: f64,
    transaction_cost_bps: f64,
    seed: u64,
    control: Option<&dyn ComputeControl>,
) -> Result<(Value, Value, Vec<String>)> {
    let (decisions, actions, mut warnings) =
        build_regime_decisions(frame, config, optimizer_config, constraints, control)?;
    if decisions.len() <= config.minimum_training_decisions {
        let warning = format!(
            "국면 정책 탐색 결정 수({})가 최소 훈련 결정 수({})와 OOS 1개를 충족하지 못했습니다.",
            decisions.len(),
            config.minimum_training_decisions
        );
        warnings.push(warning);
        return Ok((
            json!({
                "enabled": true,
                "status": "insufficient_data",
                "requestedMethod": config.requested_method.as_str(),
                "decisionCount": decisions.len(),
                "minimumTrainingDecisions": config.minimum_training_decisions,
                "states": config.states,
                "actions": actions,
                "warnings": warnings,
            }),
            json!([]),
            warnings,
        ));
    }
    let proposed_training = (decisions.len() as f64 * config.train_fraction).floor() as usize;
    let training_count = proposed_training
        .max(config.minimum_training_decisions)
        .min(decisions.len() - 1);
    let oos_decisions = &decisions[training_count..];
    let action_count = actions.len();
    let state_count = config.states.len();
    let (model, model_warnings) = build_empirical_policy_model(
        frame,
        &decisions,
        training_count,
        state_count,
        action_count,
        config.switching_cost_bps,
    );
    warnings.extend(model_warnings);
    let search_complexity = state_count
        .saturating_mul(action_count + 1)
        .saturating_mul(action_count)
        .saturating_mul(config.max_depth);
    let effective_method = match config.requested_method {
        RegimePolicyMethod::Auto if search_complexity > 30_000 => RegimePolicyMethod::Mcts,
        RegimePolicyMethod::Auto => RegimePolicyMethod::DynamicProgramming,
        method => method,
    };
    let adaptive_policy = match effective_method {
        RegimePolicyMethod::DynamicProgramming => {
            dynamic_programming_policy(&model, config.max_depth, config.discount, control)?
        }
        RegimePolicyMethod::Mcts => {
            let mut policy_rng = Mulberry32::new(seed ^ 0xA17C_9E37);
            mcts_policy(
                &model,
                config.max_depth,
                config.rollouts,
                config.exploration_constant,
                config.discount,
                &mut policy_rng,
                control,
            )?
        }
        RegimePolicyMethod::Auto => unreachable!("auto method is resolved before search"),
    };
    let mut policies = Vec::<(String, String, String, Vec<Vec<usize>>)>::new();
    policies.push((
        format!("adaptive:{}", effective_method.as_str()),
        format!("Adaptive {}", effective_method.as_str()),
        format!("regime_policy:{}", effective_method.as_str()),
        adaptive_policy,
    ));
    policies.extend(actions.iter().enumerate().map(|(action, name)| {
        (
            format!("constant:{name}"),
            format!("Constant {name}"),
            format!("regime_policy:baseline:{name}"),
            constant_regime_policy(state_count, action_count, action),
        )
    }));
    let mut candidates = policies
        .into_iter()
        .map(|(id, name, source, policy)| {
            let training_actions =
                follow_regime_policy(&policy, &decisions[..training_count], action_count);
            let oos_actions = follow_regime_policy(&policy, oos_decisions, action_count);
            let training_metrics = policy_screening_metrics(
                frame,
                &decisions[..training_count],
                &training_actions,
                annualization,
                risk_free_percent,
                transaction_cost_bps,
            );
            let oos_metrics = policy_screening_metrics(
                frame,
                oos_decisions,
                &oos_actions,
                annualization,
                risk_free_percent,
                transaction_cost_bps,
            );
            RegimePolicyCandidate {
                id,
                name,
                source,
                policy,
                training_actions,
                oos_actions,
                training_metrics,
                oos_metrics,
                screening_rank: 0,
                validation_status: if optimizer_config.ledger_template.is_some() {
                    "not_selected".to_owned()
                } else {
                    "not_requested".to_owned()
                },
                validation_error: None,
                ledger_metrics: None,
                ledger_robust_detail: None,
                ledger_data_quality: None,
                ledger_rank: None,
                rank_change: None,
            }
        })
        .collect::<Vec<_>>();
    let screening_score = |candidate: &RegimePolicyCandidate| {
        candidate
            .oos_metrics
            .get("robustScore")
            .and_then(Value::as_f64)
    };
    candidates.sort_by(
        |left, right| match (screening_score(left), screening_score(right)) {
            (Some(left), Some(right)) => right.total_cmp(&left),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => left.id.cmp(&right.id),
        },
    );
    for (rank, candidate) in candidates.iter_mut().enumerate() {
        candidate.screening_rank = rank + 1;
    }

    let mut selected = candidates
        .iter()
        .position(|candidate| candidate.id.starts_with("adaptive:"))
        .into_iter()
        .collect::<Vec<_>>();
    for index in 0..candidates.len() {
        if selected.len() >= config.ledger_validation_budget {
            break;
        }
        if !selected.contains(&index) {
            selected.push(index);
        }
    }
    let mut failed_count = 0usize;
    let mut completed = Vec::<usize>::new();
    if let Some(template) = optimizer_config.ledger_template.as_ref() {
        for (position, index) in selected.iter().copied().enumerate() {
            if position.is_multiple_of(2) {
                checkpoint(control)?;
            }
            let validation = ledger_input_for_regime_policy(
                template,
                frame,
                oos_decisions,
                &candidates[index].oos_actions,
                &config.states,
                &actions,
            )
            .and_then(|ledger_input| {
                backtest::simulate_with_control(&ledger_input, control)
                    .context("regime policy ledger validation backtest failed")
            });
            match validation {
                Ok(result) => {
                    let (metrics, robust_detail) =
                        ledger_metrics(&result, &optimizer_config.robust_weights);
                    candidates[index].validation_status = "completed".to_owned();
                    candidates[index].ledger_metrics = Some(metrics);
                    candidates[index].ledger_robust_detail = Some(robust_detail);
                    candidates[index].ledger_data_quality =
                        Some(serde_json::to_value(&result.data_quality)?);
                    completed.push(index);
                }
                Err(error) => {
                    failed_count += 1;
                    candidates[index].validation_status = "failed".to_owned();
                    candidates[index].validation_error = Some(error.to_string());
                }
            }
        }
        completed.sort_by(|left, right| {
            let score = |index: usize| {
                candidates[index]
                    .ledger_metrics
                    .as_ref()
                    .and_then(|metrics| metrics.get("robustScore"))
                    .and_then(Value::as_f64)
            };
            match (score(*left), score(*right)) {
                (Some(left), Some(right)) => right.total_cmp(&left),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => candidates[*left].id.cmp(&candidates[*right].id),
            }
        });
        for (rank, index) in completed.iter().copied().enumerate() {
            candidates[index].ledger_rank = Some(rank + 1);
            candidates[index].rank_change =
                Some(candidates[index].screening_rank as i64 - (rank + 1) as i64);
        }
    } else {
        warnings.push(
            "ledgerTemplate이 없어 국면 정책 후보는 screening까지만 수행했습니다.".to_owned(),
        );
    }
    if failed_count > 0 {
        warnings.push(format!(
            "국면 정책 ledger 재검증 후보 {failed_count}개가 실패했습니다. 후보별 validationError를 확인하세요."
        ));
    }
    warnings.push(
        "국면 정책은 훈련 구간의 역사적 상태 전이와 보상에 적합화되며 미래 성과를 보장하지 않습니다."
            .to_owned(),
    );

    let best_index = completed.first().copied().unwrap_or(0);
    let summaries = candidates
        .iter()
        .map(|candidate| {
            let trace = policy_trace_json(
                oos_decisions,
                &candidate.oos_actions,
                &config.states,
                &actions,
            );
            regime_policy_candidate_json(
                candidate,
                &config.states,
                &actions,
                &trace.into_iter().take(20).collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    let artifact = candidates
        .iter()
        .map(|candidate| {
            let training_trace = policy_trace_json(
                &decisions[..training_count],
                &candidate.training_actions,
                &config.states,
                &actions,
            );
            let oos_trace = policy_trace_json(
                oos_decisions,
                &candidate.oos_actions,
                &config.states,
                &actions,
            );
            json!({
                "policy": regime_policy_candidate_json(
                    candidate,
                    &config.states,
                    &actions,
                    &[],
                ),
                "trainingDecisionTrace": training_trace,
                "oosDecisionTrace": oos_trace,
            })
        })
        .collect::<Vec<_>>();
    let training_end_return = decisions[training_count - 1].return_end.saturating_sub(1);
    let oos_observations = candidates[best_index]
        .oos_metrics
        .get("sampleCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let ledger_status = if optimizer_config.ledger_template.is_none() {
        "not_requested"
    } else if completed.is_empty() {
        "failed"
    } else if failed_count > 0 {
        "partial"
    } else {
        "completed"
    };
    let status = if optimizer_config.ledger_template.is_none() {
        "screening_only"
    } else {
        ledger_status
    };
    let reward_model = Value::Object(
        config
            .states
            .iter()
            .enumerate()
            .map(|(state, name)| {
                (
                    name.clone(),
                    Value::Object(
                        actions
                            .iter()
                            .enumerate()
                            .map(|(action, name)| {
                                (name.clone(), json!(model.rewards[state][action]))
                            })
                            .collect(),
                    ),
                )
            })
            .collect(),
    );
    let transition_model = Value::Object(
        config
            .states
            .iter()
            .enumerate()
            .map(|(state, name)| {
                (
                    name.clone(),
                    Value::Object(
                        config
                            .states
                            .iter()
                            .enumerate()
                            .map(|(next, name)| {
                                (name.clone(), json!(model.transitions[state][next]))
                            })
                            .collect(),
                    ),
                )
            })
            .collect(),
    );
    let summary = json!({
        "enabled": true,
        "status": status,
        "requestedMethod": config.requested_method.as_str(),
        "effectiveMethod": effective_method.as_str(),
        "implementation": if effective_method == RegimePolicyMethod::Mcts {
            "uct_tree_search_empirical_markov_model"
        } else {
            "finite_horizon_bellman_dynamic_programming"
        },
        "deterministic": true,
        "seed": seed,
        "states": config.states,
        "actions": actions,
        "decisionCount": decisions.len(),
        "trainingDecisionCount": training_count,
        "oosDecisionCount": oos_decisions.len(),
        "oosCoverage": oos_observations as f64 / frame.returns.len().max(1) as f64,
        "config": {
            "lookback": config.lookback,
            "rebalanceEvery": config.rebalance_every,
            "trainFraction": config.train_fraction,
            "minimumTrainingDecisions": config.minimum_training_decisions,
            "maxDepth": config.max_depth,
            "rollouts": config.rollouts,
            "explorationConstant": config.exploration_constant,
            "discount": config.discount,
            "switchingCostBps": config.switching_cost_bps,
            "ledgerValidationBudget": config.ledger_validation_budget,
            "autoSearchComplexity": search_complexity,
            "autoMctsThreshold": 30_000,
        },
        "noLookahead": {
            "stateClassifier": "equal_weight_market_risk_adjusted_momentum_fixed_boundaries",
            "stateBoundaries": "fixed_equal_width_bins_over_clipped_minus_one_to_one_signal",
            "signalWindow": "rolling_past_only",
            "signalCutoff": "strictly_before_decision_date",
            "actionCovarianceWindow": "rolling_past_only",
            "policyFit": "training_decisions_only",
            "policyFrozenForOos": true,
            "trainingStartDate": decisions.first().map(|decision| &decision.date),
            "trainingEndDate": frame.dates.get(training_end_return),
            "oosStartDate": oos_decisions.first().map(|decision| &decision.date),
        },
        "empiricalModel": {
            "stateActionMeanLogRewards": reward_model,
            "transitionProbabilities": transition_model,
            "transitionPrior": 1e-6,
            "switchingCostsIncluded": config.switching_cost_bps > 0.0,
        },
        "policies": summaries,
        "bestPolicy": summaries.get(best_index),
        "ledgerValidation": {
            "status": ledger_status,
            "budget": config.ledger_validation_budget,
            "selectedCount": if optimizer_config.ledger_template.is_some() { selected.len() } else { 0 },
            "completedCount": completed.len(),
            "failedCount": failed_count,
            "selectionPolicy": "adaptive_then_oos_screening_rank",
            "rankingMetric": "ledger_robust_score",
        },
        "warnings": warnings,
    });
    Ok((summary, Value::Array(artifact), warnings))
}
