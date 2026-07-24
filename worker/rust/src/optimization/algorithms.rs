use std::collections::{BTreeSet, HashSet};

use crate::portfolio_math;

use super::baseline::random_dense_candidate;
use super::constraints::repair_dense_weights;
use super::{
    Algorithm, Constraints, EvaluationOptions, Frame, Mulberry32, OptimizerV2Config, ProxyMetrics,
    Weights, as_metric, evaluate_candidate, portfolio_returns, proxy_metrics, quantile_linear,
    signature,
};

pub(super) fn training_objective_fitness(
    frame: &Frame,
    weights: &Weights,
    objective: &str,
    options: &EvaluationOptions<'_>,
) -> f64 {
    // Search fitness must never consume the inner OOS windows. Reuse the canonical
    // candidate evaluator with an explicitly training-only view so metric semantics
    // (risk-free rate, benchmark, transaction cost, and robust weights) stay aligned
    // with the screening result without leaking validation observations.
    let training_options = EvaluationOptions {
        benchmark: options.benchmark,
        oos_frame: None,
        annualization: options.annualization,
        confidence: options.confidence,
        minimum_samples: options.minimum_samples,
        risk_free_percent: options.risk_free_percent,
        windows: &[],
        validation_config: None,
        constraints: options.constraints,
        transaction_cost_bps: options.transaction_cost_bps,
        robust_weights: options.robust_weights,
    };
    let candidate = evaluate_candidate(frame, weights, &training_options);
    let key = match objective {
        "max_cagr" => "cagr",
        "max_total_return" => "totalReturn",
        "max_sharpe" => "sharpe",
        "max_sortino" => "sortino",
        "max_calmar" => "calmar",
        "min_volatility" => "volatility",
        "min_cvar" => "cvar",
        "max_information_ratio" => "informationRatio",
        "robust_score" => "robustScore",
        _ => return f64::NEG_INFINITY,
    };
    as_metric(&candidate, key)
        .map(|value| match objective {
            "min_volatility" => -value,
            "min_cvar" => -value.abs(),
            _ => value,
        })
        .filter(|value| value.is_finite())
        .unwrap_or(f64::NEG_INFINITY)
}

pub(super) fn differential_evolution_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    constraints: &Constraints,
    config: &OptimizerV2Config,
    fitness: (&str, &EvaluationOptions<'_>),
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() {
        return Vec::new();
    }
    let population_size = (frame.ids.len() * 6)
        .clamp(12, 64)
        .min((budget / 2).max(4))
        .min(budget);
    let mut population = Vec::new();
    for _ in 0..population_size * 20 {
        if let Some(candidate) = random_dense_candidate(rng, frame, constraints, config) {
            population.push(candidate);
            if population.len() == population_size {
                break;
            }
        }
    }
    let mut population_fitness = population
        .iter()
        .map(|weights| training_objective_fitness(frame, weights, fitness.0, fitness.1))
        .collect::<Vec<_>>();
    let mut output = population
        .iter()
        .cloned()
        .map(|weights| (weights, "differential_evolution".to_owned()))
        .collect::<Vec<_>>();
    let mut generations = 0usize;
    while output.len() < budget && population.len() >= 4 && generations < budget * 4 {
        generations += 1;
        for target in 0..population.len() {
            let mut picks = Vec::new();
            while picks.len() < 3 {
                let pick = rng.next_int(population.len());
                if pick != target && !picks.contains(&pick) {
                    picks.push(pick);
                }
            }
            let a = population[picks[0]].dense(&frame.ids);
            let b = population[picks[1]].dense(&frame.ids);
            let c = population[picks[2]].dense(&frame.ids);
            let current = population[target].dense(&frame.ids);
            let forced = rng.next_int(frame.ids.len());
            let raw = (0..frame.ids.len())
                .map(|index| {
                    if index == forced || rng.next() < 0.75 {
                        a[index] + 0.65 * (b[index] - c[index])
                    } else {
                        current[index]
                    }
                })
                .collect::<Vec<_>>();
            let Some(trial) = repair_dense_weights(
                &raw,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            ) else {
                continue;
            };
            let trial_fitness = training_objective_fitness(frame, &trial, fitness.0, fitness.1);
            if trial_fitness >= population_fitness[target] {
                population[target] = trial.clone();
                population_fitness[target] = trial_fitness;
            }
            output.push((trial, "differential_evolution".to_owned()));
            if output.len() >= budget {
                break;
            }
        }
    }
    // Put the evolved population first. The caller may over-generate and then
    // truncate after de-duplication, so returning the initial population first
    // would silently discard every objective-aware selection step.
    let mut prioritized = Vec::with_capacity(budget);
    let mut seen = HashSet::new();
    for weights in population
        .into_iter()
        .chain(output.into_iter().map(|(weights, _)| weights))
    {
        if seen.insert(signature(&weights)) {
            prioritized.push((weights, "differential_evolution".to_owned()));
            if prioritized.len() >= budget {
                break;
            }
        }
    }
    prioritized
}

pub(super) fn cma_es_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
    config: &OptimizerV2Config,
    fitness: (&str, &EvaluationOptions<'_>),
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() {
        return Vec::new();
    }
    let dimensions = frame.ids.len();
    let mut center = portfolio_math::inverse_volatility(covariance)
        .or_else(|| portfolio_math::equal_weight(dimensions))
        .unwrap_or_default();
    let mut diagonal = vec![1.0_f64; dimensions];
    let mut covariance_path = vec![0.0_f64; dimensions];
    let mut step_path = vec![0.0_f64; dimensions];
    let lambda = (4.0 + 3.0 * (dimensions as f64).ln()).round() as usize;
    let lambda = lambda.max(4).min(budget.max(4));
    let mut sigma = 0.25_f64;
    let expected_normal_length = (dimensions as f64).sqrt()
        * (1.0 - 1.0 / (4.0 * dimensions as f64) + 1.0 / (21.0 * (dimensions * dimensions) as f64));
    let mut output = Vec::new();
    let mut final_generation = Vec::new();
    let mut generation_index = 0usize;
    while output.len() < budget {
        generation_index += 1;
        let mut generation = Vec::new();
        for _ in 0..lambda {
            let raw = (0..dimensions)
                .map(|index| center[index] + sigma * diagonal[index].sqrt() * rng.normal())
                .collect::<Vec<_>>();
            if let Some(weights) = repair_dense_weights(
                &raw,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            ) {
                let score = training_objective_fitness(frame, &weights, fitness.0, fitness.1);
                generation.push((score, weights));
            }
        }
        if generation.is_empty() {
            break;
        }
        generation.sort_by(|left, right| right.0.total_cmp(&left.0));
        let elite_count = (generation.len() / 2).max(1);
        let elites = &generation[..elite_count];
        let mut recombination_weights = (0..elite_count)
            .map(|index| ((elite_count as f64 + 0.5).ln() - ((index + 1) as f64).ln()).max(0.0))
            .collect::<Vec<_>>();
        let weight_total = recombination_weights.iter().sum::<f64>().max(1e-18);
        for weight in &mut recombination_weights {
            *weight /= weight_total;
        }
        let effective_mu = 1.0
            / recombination_weights
                .iter()
                .map(|weight| weight * weight)
                .sum::<f64>()
                .max(1e-18);
        let dimension = dimensions as f64;
        let step_path_rate = (effective_mu + 2.0) / (dimension + effective_mu + 5.0);
        let step_damping =
            1.0 + 2.0 * ((effective_mu - 1.0).max(0.0) / (dimension + 1.0)).sqrt() + step_path_rate;
        let covariance_path_rate =
            (4.0 + effective_mu / dimension) / (dimension + 4.0 + 2.0 * effective_mu / dimension);
        let rank_one_rate = 2.0 / ((dimension + 1.3).powi(2) + effective_mu);
        let rank_mu_rate = (2.0 * (effective_mu - 2.0 + 1.0 / effective_mu)
            / ((dimension + 2.0).powi(2) + effective_mu))
            .clamp(0.0, 1.0 - rank_one_rate);
        let old_center = center.clone();
        let old_diagonal = diagonal.clone();
        let elite_dense = elites
            .iter()
            .map(|(_, weights)| weights.dense(&frame.ids))
            .collect::<Vec<_>>();
        let weighted_step = (0..dimensions)
            .map(|index| {
                elite_dense
                    .iter()
                    .zip(&recombination_weights)
                    .map(|(weights, weight)| {
                        weight * (weights[index] - old_center[index]) / sigma.max(1e-18)
                    })
                    .sum::<f64>()
            })
            .collect::<Vec<_>>();
        center = (0..dimensions)
            .map(|index| {
                elite_dense
                    .iter()
                    .zip(&recombination_weights)
                    .map(|(weights, weight)| weight * weights[index])
                    .sum::<f64>()
            })
            .collect();
        for index in 0..dimensions {
            let whitened_step = weighted_step[index] / old_diagonal[index].sqrt().max(1e-18);
            step_path[index] = (1.0 - step_path_rate) * step_path[index]
                + (step_path_rate * (2.0 - step_path_rate) * effective_mu).sqrt() * whitened_step;
        }
        let step_path_length = step_path
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt();
        let normalized_path_length = step_path_length
            / (1.0 - (1.0 - step_path_rate).powi(2 * generation_index as i32))
                .sqrt()
                .max(1e-18);
        let path_is_stable =
            normalized_path_length < (1.4 + 2.0 / (dimension + 1.0)) * expected_normal_length;
        let path_indicator = if path_is_stable { 1.0 } else { 0.0 };
        for index in 0..dimensions {
            covariance_path[index] = (1.0 - covariance_path_rate) * covariance_path[index]
                + path_indicator
                    * (covariance_path_rate * (2.0 - covariance_path_rate) * effective_mu).sqrt()
                    * weighted_step[index];
            let rank_mu = elite_dense
                .iter()
                .zip(&recombination_weights)
                .map(|(weights, weight)| {
                    let step = (weights[index] - old_center[index]) / sigma.max(1e-18);
                    weight * step * step
                })
                .sum::<f64>();
            diagonal[index] = ((1.0 - rank_one_rate - rank_mu_rate) * old_diagonal[index]
                + rank_one_rate
                    * (covariance_path[index].powi(2)
                        + (1.0 - path_indicator)
                            * covariance_path_rate
                            * (2.0 - covariance_path_rate)
                            * old_diagonal[index])
                + rank_mu_rate * rank_mu)
                .clamp(1e-12, 1e6);
        }
        sigma *= ((step_path_rate / step_damping)
            * (step_path_length / expected_normal_length.max(1e-18) - 1.0))
            .exp();
        sigma = sigma.clamp(1e-4, 2.0);
        final_generation = generation
            .iter()
            .map(|(_, weights)| weights.clone())
            .collect();
        output.extend(
            generation
                .into_iter()
                .map(|(_, weights)| (weights, "cma_es".to_owned())),
        );
    }
    // As with DE, prioritize the latest ranked generation so an upstream
    // over-generation/truncation step retains the objective-guided search result.
    let mut prioritized = Vec::with_capacity(budget);
    let mut seen = HashSet::new();
    for weights in final_generation
        .into_iter()
        .chain(output.into_iter().map(|(weights, _)| weights))
    {
        if seen.insert(signature(&weights)) {
            prioritized.push((weights, "cma_es".to_owned()));
            if prioritized.len() >= budget {
                break;
            }
        }
    }
    prioritized
}

fn proxy_dominates(left: ProxyMetrics, right: ProxyMetrics) -> bool {
    let no_worse = left.portfolio_return >= right.portfolio_return
        && left.volatility <= right.volatility
        && left.cvar >= right.cvar;
    no_worse
        && (left.portfolio_return > right.portfolio_return
            || left.volatility < right.volatility
            || left.cvar > right.cvar)
}

fn nsga_rank_and_crowding(metrics: &[ProxyMetrics]) -> Vec<(usize, f64)> {
    let mut remaining = (0..metrics.len()).collect::<Vec<_>>();
    let mut result = vec![(usize::MAX, 0.0); metrics.len()];
    let mut rank = 0usize;
    while !remaining.is_empty() {
        let front = remaining
            .iter()
            .copied()
            .filter(|candidate| {
                !remaining.iter().copied().any(|other| {
                    other != *candidate && proxy_dominates(metrics[other], metrics[*candidate])
                })
            })
            .collect::<Vec<_>>();
        if front.is_empty() {
            break;
        }
        for candidate in &front {
            result[*candidate].0 = rank;
        }
        for dimension in 0..3 {
            let mut sorted = front.clone();
            sorted.sort_by(|left, right| {
                let value = |index: usize| match dimension {
                    0 => metrics[index].portfolio_return,
                    1 => metrics[index].volatility,
                    _ => metrics[index].cvar,
                };
                value(*left).total_cmp(&value(*right))
            });
            if let (Some(first), Some(last)) = (sorted.first(), sorted.last()) {
                result[*first].1 = f64::INFINITY;
                result[*last].1 = f64::INFINITY;
                let low = match dimension {
                    0 => metrics[*first].portfolio_return,
                    1 => metrics[*first].volatility,
                    _ => metrics[*first].cvar,
                };
                let high = match dimension {
                    0 => metrics[*last].portfolio_return,
                    1 => metrics[*last].volatility,
                    _ => metrics[*last].cvar,
                };
                let span = (high - low).abs().max(1e-18);
                for window in sorted.windows(3) {
                    let previous = match dimension {
                        0 => metrics[window[0]].portfolio_return,
                        1 => metrics[window[0]].volatility,
                        _ => metrics[window[0]].cvar,
                    };
                    let next = match dimension {
                        0 => metrics[window[2]].portfolio_return,
                        1 => metrics[window[2]].volatility,
                        _ => metrics[window[2]].cvar,
                    };
                    result[window[1]].1 += (next - previous).abs() / span;
                }
            }
        }
        let front_set = front.into_iter().collect::<BTreeSet<_>>();
        remaining.retain(|candidate| !front_set.contains(candidate));
        rank += 1;
    }
    result
}

fn nsga_ii_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
    config: &OptimizerV2Config,
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() {
        return Vec::new();
    }
    let population_size = (frame.ids.len() * 8)
        .clamp(16, 80)
        .min((budget / 2).max(4))
        .min(budget);
    let mut population = Vec::new();
    for _ in 0..population_size * 20 {
        if let Some(candidate) = random_dense_candidate(rng, frame, constraints, config) {
            population.push(candidate);
            if population.len() == population_size {
                break;
            }
        }
    }
    let mut output = population
        .iter()
        .cloned()
        .map(|weights| (weights, "nsga_ii".to_owned()))
        .collect::<Vec<_>>();
    while output.len() < budget && population.len() >= 2 {
        let metrics = population
            .iter()
            .map(|weights| proxy_metrics(frame, covariance, &weights.dense(&frame.ids)))
            .collect::<Vec<_>>();
        let rank = nsga_rank_and_crowding(&metrics);
        let tournament = |left: usize, right: usize| {
            if rank[left].0 < rank[right].0
                || (rank[left].0 == rank[right].0 && rank[left].1 >= rank[right].1)
            {
                left
            } else {
                right
            }
        };
        let mut offspring = Vec::new();
        for _ in 0..population_size {
            let left = tournament(
                rng.next_int(population.len()),
                rng.next_int(population.len()),
            );
            let right = tournament(
                rng.next_int(population.len()),
                rng.next_int(population.len()),
            );
            let left = population[left].dense(&frame.ids);
            let right = population[right].dense(&frame.ids);
            let mix = rng.next();
            let raw = left
                .iter()
                .zip(right)
                .map(|(left, right)| mix * left + (1.0 - mix) * right + 0.04 * rng.normal())
                .collect::<Vec<_>>();
            if let Some(candidate) = repair_dense_weights(
                &raw,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            ) {
                offspring.push(candidate);
            }
        }
        if offspring.is_empty() {
            break;
        }
        let mut combined = population;
        combined.extend(offspring.iter().cloned());
        let combined_metrics = combined
            .iter()
            .map(|weights| proxy_metrics(frame, covariance, &weights.dense(&frame.ids)))
            .collect::<Vec<_>>();
        let combined_rank = nsga_rank_and_crowding(&combined_metrics);
        let mut indices = (0..combined.len()).collect::<Vec<_>>();
        indices.sort_by(|left, right| {
            combined_rank[*left]
                .0
                .cmp(&combined_rank[*right].0)
                .then_with(|| combined_rank[*right].1.total_cmp(&combined_rank[*left].1))
                .then_with(|| left.cmp(right))
        });
        population = indices
            .into_iter()
            .take(population_size)
            .map(|index| combined[index].clone())
            .collect();
        output.extend(
            offspring
                .into_iter()
                .map(|weights| (weights, "nsga_ii".to_owned())),
        );
    }
    output.truncate(budget);
    output
}

fn direct_cvar_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    constraints: &Constraints,
    config: &OptimizerV2Config,
    budget: usize,
) -> Vec<(Weights, String)> {
    if budget == 0 || frame.ids.is_empty() || frame.returns.is_empty() {
        return Vec::new();
    }
    let mut weights = portfolio_math::equal_weight(frame.ids.len()).unwrap_or_default();
    let mut output = Vec::new();
    for iteration in 0..budget * 8 {
        let returns = portfolio_returns(frame, &weights);
        let threshold = quantile_linear(&returns, 0.05).unwrap_or(0.0);
        let tail = returns
            .iter()
            .enumerate()
            .filter(|(_, value)| **value <= threshold)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let step = 0.15 / (1.0 + iteration as f64 * 0.05).sqrt();
        let gradient = (0..frame.ids.len())
            .map(|asset| {
                if tail.is_empty() {
                    0.0
                } else {
                    tail.iter()
                        .map(|index| frame.returns[*index][asset])
                        .sum::<f64>()
                        / tail.len() as f64
                }
            })
            .collect::<Vec<_>>();
        let raw = weights
            .iter()
            .zip(gradient)
            .map(|(weight, gradient)| weight + step * gradient + rng.normal() * step * 0.02)
            .collect::<Vec<_>>();
        if let Some(candidate) = repair_dense_weights(
            &raw,
            &frame.ids,
            constraints,
            &config.group_constraints,
            &config.asset_groups,
        ) {
            weights = candidate.dense(&frame.ids);
            output.push((candidate, "direct_cvar".to_owned()));
            if output.len() >= budget {
                break;
            }
        }
    }
    output
}

pub(super) fn advanced_candidates(
    rng: &mut Mulberry32,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
    config: &OptimizerV2Config,
    fitness: (&str, &EvaluationOptions<'_>),
    budget: usize,
) -> Vec<(Weights, String)> {
    match config.algorithm {
        Algorithm::RandomSearch => Vec::new(),
        Algorithm::DifferentialEvolution => {
            differential_evolution_candidates(rng, frame, constraints, config, fitness, budget)
        }
        Algorithm::CmaEs => {
            cma_es_candidates(rng, frame, covariance, constraints, config, fitness, budget)
        }
        Algorithm::NsgaIi => {
            nsga_ii_candidates(rng, frame, covariance, constraints, config, budget)
        }
        Algorithm::DirectCvar => direct_cvar_candidates(rng, frame, constraints, config, budget),
    }
}
