//! Deterministic, dependency-free portfolio mathematics used by the screening optimizer.
//!
//! The routines deliberately avoid native BLAS and randomized decompositions so a fixed input
//! produces the same candidate seeds on every worker replica.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CovarianceEstimator {
    Sample,
    LedoitWolf,
}

pub fn mean_returns(returns: &[Vec<f64>], asset_count: usize) -> Vec<f64> {
    if returns.is_empty() {
        return vec![0.0; asset_count];
    }
    let mut means = vec![0.0; asset_count];
    for row in returns {
        for (index, value) in row.iter().take(asset_count).enumerate() {
            means[index] += value;
        }
    }
    for value in &mut means {
        *value /= returns.len() as f64;
    }
    means
}

pub fn covariance_matrix(
    returns: &[Vec<f64>],
    asset_count: usize,
    estimator: CovarianceEstimator,
) -> Vec<Vec<f64>> {
    if returns.len() < 2 || asset_count == 0 {
        return vec![vec![0.0; asset_count]; asset_count];
    }
    let means = mean_returns(returns, asset_count);
    let denominator = match estimator {
        CovarianceEstimator::Sample => (returns.len() - 1) as f64,
        CovarianceEstimator::LedoitWolf => returns.len() as f64,
    };
    let mut covariance = vec![vec![0.0; asset_count]; asset_count];
    for row in returns {
        for left in 0..asset_count {
            let left_delta = row.get(left).copied().unwrap_or(0.0) - means[left];
            for right in 0..=left {
                covariance[left][right] +=
                    left_delta * (row.get(right).copied().unwrap_or(0.0) - means[right]);
            }
        }
    }
    for (left, row) in covariance.iter_mut().enumerate().take(asset_count) {
        for value in row.iter_mut().take(left + 1) {
            *value /= denominator;
        }
    }
    let mut left = 0usize;
    while left < asset_count {
        let mut right = 0usize;
        while right < left {
            covariance[right][left] = covariance[left][right];
            right += 1;
        }
        left += 1;
    }
    if estimator == CovarianceEstimator::LedoitWolf {
        ledoit_wolf_shrink(returns, &means, &mut covariance);
    }
    covariance
}

/// Shrinks the population covariance toward a scaled identity matrix using the Ledoit-Wolf
/// Frobenius-risk intensity. The finite-sample intensity is clamped to `[0, 1]`.
fn ledoit_wolf_shrink(returns: &[Vec<f64>], means: &[f64], covariance: &mut [Vec<f64>]) {
    let observations = returns.len();
    let assets = means.len();
    if observations == 0 || assets == 0 {
        return;
    }
    let target_variance = (0..assets)
        .map(|index| covariance[index][index])
        .sum::<f64>()
        / assets as f64;
    let mut delta = 0.0;
    for (left, row) in covariance.iter().enumerate().take(assets) {
        for (right, value) in row.iter().enumerate().take(assets) {
            let target = if left == right { target_variance } else { 0.0 };
            delta += (*value - target).powi(2);
        }
    }
    if delta <= f64::EPSILON {
        return;
    }
    let mut phi = 0.0;
    for row in returns {
        for left in 0..assets {
            let left_delta = row.get(left).copied().unwrap_or(0.0) - means[left];
            for right in 0..assets {
                let outer = left_delta * (row.get(right).copied().unwrap_or(0.0) - means[right]);
                phi += (outer - covariance[left][right]).powi(2);
            }
        }
    }
    phi /= observations as f64;
    let intensity = (phi / (observations as f64 * delta)).clamp(0.0, 1.0);
    for (left, row) in covariance.iter_mut().enumerate().take(assets) {
        for (right, value) in row.iter_mut().enumerate().take(assets) {
            let target = if left == right { target_variance } else { 0.0 };
            *value = (1.0 - intensity) * *value + intensity * target;
        }
    }
}

pub fn normalize_long_only(values: &[f64]) -> Option<Vec<f64>> {
    let mut normalized = values
        .iter()
        .map(|value| {
            if value.is_finite() {
                value.max(0.0)
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let total = normalized.iter().sum::<f64>();
    if total <= f64::EPSILON {
        return None;
    }
    for value in &mut normalized {
        *value /= total;
    }
    Some(normalized)
}

pub fn portfolio_variance(weights: &[f64], covariance: &[Vec<f64>]) -> f64 {
    weights
        .iter()
        .enumerate()
        .map(|(left, left_weight)| {
            weights
                .iter()
                .enumerate()
                .map(|(right, right_weight)| {
                    left_weight
                        * right_weight
                        * covariance
                            .get(left)
                            .and_then(|row| row.get(right))
                            .copied()
                            .unwrap_or(0.0)
                })
                .sum::<f64>()
        })
        .sum::<f64>()
        .max(0.0)
}

fn marginal_risk(weights: &[f64], covariance: &[Vec<f64>], index: usize) -> f64 {
    weights
        .iter()
        .enumerate()
        .map(|(other, weight)| {
            weight
                * covariance
                    .get(index)
                    .and_then(|row| row.get(other))
                    .copied()
                    .unwrap_or(0.0)
        })
        .sum()
}

pub fn equal_weight(asset_count: usize) -> Option<Vec<f64>> {
    (asset_count > 0).then(|| vec![1.0 / asset_count as f64; asset_count])
}

pub fn inverse_volatility(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    normalize_long_only(
        &(0..covariance.len())
            .map(|index| {
                let variance = covariance[index].get(index).copied().unwrap_or(0.0);
                if variance > 1e-18 {
                    1.0 / variance.sqrt()
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>(),
    )
    .or_else(|| equal_weight(covariance.len()))
}

pub fn minimum_variance(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    let count = covariance.len();
    let mut weights = equal_weight(count)?;
    let maximum_diagonal = (0..count)
        .map(|index| covariance[index].get(index).copied().unwrap_or(0.0))
        .fold(0.0_f64, f64::max)
        .max(1e-12);
    let step = 0.2 / maximum_diagonal;
    for _ in 0..600 {
        let gradient = (0..count)
            .map(|index| 2.0 * marginal_risk(&weights, covariance, index))
            .collect::<Vec<_>>();
        let next = normalize_long_only(
            &weights
                .iter()
                .zip(gradient)
                .map(|(weight, gradient)| weight - step * gradient)
                .collect::<Vec<_>>(),
        )?;
        let change = weights
            .iter()
            .zip(&next)
            .map(|(left, right)| (left - right).abs())
            .sum::<f64>();
        weights = next;
        if change < 1e-12 {
            break;
        }
    }
    Some(weights)
}

pub fn risk_parity(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    let count = covariance.len();
    let mut weights = inverse_volatility(covariance)?;
    for _ in 0..1_000 {
        let variance = portfolio_variance(&weights, covariance).max(1e-18);
        let target = variance / count.max(1) as f64;
        let mut next = weights.clone();
        for index in 0..count {
            let contribution = weights[index] * marginal_risk(&weights, covariance, index);
            if contribution > 1e-18 {
                next[index] *= (target / contribution).sqrt();
            }
        }
        next = normalize_long_only(&next)?;
        let change = weights
            .iter()
            .zip(&next)
            .map(|(left, right)| (left - right).abs())
            .sum::<f64>();
        weights = next;
        if change < 1e-10 {
            break;
        }
    }
    Some(weights)
}

fn correlation_distance(covariance: &[Vec<f64>], left: usize, right: usize) -> f64 {
    let denominator = (covariance[left][left].max(0.0) * covariance[right][right].max(0.0)).sqrt();
    let correlation = if denominator > 1e-18 {
        (covariance[left][right] / denominator).clamp(-1.0, 1.0)
    } else if left == right {
        1.0
    } else {
        0.0
    };
    ((1.0 - correlation) * 0.5).max(0.0).sqrt()
}

fn hierarchical_order(covariance: &[Vec<f64>]) -> Vec<usize> {
    let mut clusters = (0..covariance.len())
        .map(|index| vec![index])
        .collect::<Vec<_>>();
    while clusters.len() > 1 {
        let mut best = (f64::INFINITY, usize::MAX, usize::MAX);
        for left in 0..clusters.len() {
            for right in left + 1..clusters.len() {
                let distance = clusters[left]
                    .iter()
                    .flat_map(|left_asset| {
                        clusters[right].iter().map(move |right_asset| {
                            correlation_distance(covariance, *left_asset, *right_asset)
                        })
                    })
                    .fold(f64::INFINITY, f64::min);
                let candidate = (distance, left, right);
                if candidate < best {
                    best = candidate;
                }
            }
        }
        if best.1 == usize::MAX {
            break;
        }
        let right = clusters.remove(best.2);
        clusters[best.1].extend(right);
    }
    clusters.pop().unwrap_or_default()
}

fn cluster_variance(indices: &[usize], covariance: &[Vec<f64>]) -> f64 {
    let inverse = indices
        .iter()
        .map(|index| {
            let variance = covariance[*index][*index];
            if variance > 1e-18 {
                1.0 / variance
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let weights = normalize_long_only(&inverse)
        .unwrap_or_else(|| vec![1.0 / indices.len().max(1) as f64; indices.len()]);
    let mut variance = 0.0;
    for (left_position, left) in indices.iter().enumerate() {
        for (right_position, right) in indices.iter().enumerate() {
            variance +=
                weights[left_position] * weights[right_position] * covariance[*left][*right];
        }
    }
    variance.max(1e-18)
}

fn hierarchical_allocation(covariance: &[Vec<f64>], volatility_split: bool) -> Option<Vec<f64>> {
    let order = hierarchical_order(covariance);
    if order.is_empty() {
        return None;
    }
    let mut weights = vec![1.0; covariance.len()];
    let mut clusters = vec![order];
    while let Some(cluster) = clusters.pop() {
        if cluster.len() <= 1 {
            continue;
        }
        let middle = cluster.len() / 2;
        let left = cluster[..middle].to_vec();
        let right = cluster[middle..].to_vec();
        let mut left_risk = cluster_variance(&left, covariance);
        let mut right_risk = cluster_variance(&right, covariance);
        if volatility_split {
            left_risk = left_risk.sqrt();
            right_risk = right_risk.sqrt();
        }
        let allocation_left = right_risk / (left_risk + right_risk);
        for index in &left {
            weights[*index] *= allocation_left;
        }
        for index in &right {
            weights[*index] *= 1.0 - allocation_left;
        }
        clusters.push(right);
        clusters.push(left);
    }
    normalize_long_only(&weights)
}

pub fn hrp(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    hierarchical_allocation(covariance, false)
}

pub fn herc(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    hierarchical_allocation(covariance, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn returns() -> Vec<Vec<f64>> {
        vec![
            vec![0.01, 0.005, -0.002],
            vec![-0.004, 0.002, 0.003],
            vec![0.007, -0.003, 0.001],
            vec![0.002, 0.004, -0.001],
            vec![-0.003, 0.001, 0.002],
        ]
    }

    #[test]
    fn ledoit_wolf_is_deterministic_and_shrinks_off_diagonal_risk() {
        let source = returns();
        let sample = covariance_matrix(&source, 3, CovarianceEstimator::Sample);
        let first = covariance_matrix(&source, 3, CovarianceEstimator::LedoitWolf);
        let second = covariance_matrix(&source, 3, CovarianceEstimator::LedoitWolf);
        assert_eq!(first, second);
        assert!(first[0][0] >= 0.0 && first[1][1] >= 0.0 && first[2][2] >= 0.0);
        assert!(first[0][1].abs() <= sample[0][1].abs() + 1e-12);
    }

    #[test]
    fn all_baseline_math_is_long_only_and_normalized() {
        let covariance = covariance_matrix(&returns(), 3, CovarianceEstimator::LedoitWolf);
        let candidates = [
            equal_weight(3),
            inverse_volatility(&covariance),
            minimum_variance(&covariance),
            risk_parity(&covariance),
            hrp(&covariance),
            herc(&covariance),
        ];
        for candidate in candidates {
            let candidate = candidate.expect("baseline");
            assert!(
                candidate
                    .iter()
                    .all(|value| *value >= 0.0 && value.is_finite())
            );
            assert!((candidate.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
        assert_ne!(hrp(&covariance), herc(&covariance));
    }
}
