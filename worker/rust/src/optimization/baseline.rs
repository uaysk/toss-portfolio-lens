use std::cmp::Ordering;

use crate::portfolio_math::{self, normalize_long_only};

use super::constraints::repair_dense_weights;
use super::{Constraints, Frame, Mulberry32, OptimizerV2Config, Weights};

fn herc_correlation_distance(covariance: &[Vec<f64>], left: usize, right: usize) -> f64 {
    let left_variance = covariance[left][left].max(0.0);
    let right_variance = covariance[right][right].max(0.0);
    let denominator = (left_variance * right_variance).sqrt();
    let correlation = if denominator > 1e-18 {
        (covariance[left][right] / denominator).clamp(-1.0, 1.0)
    } else if left == right {
        1.0
    } else {
        0.0
    };
    ((1.0 - correlation) * 0.5).max(0.0).sqrt()
}

fn herc_average_linkage(left: &[usize], right: &[usize], distances: &[Vec<f64>]) -> f64 {
    let pair_count = left.len().saturating_mul(right.len()).max(1);
    left.iter()
        .flat_map(|left_asset| {
            right
                .iter()
                .map(move |right_asset| distances[*left_asset][*right_asset])
        })
        .sum::<f64>()
        / pair_count as f64
}

fn herc_mean_silhouette(clusters: &[Vec<usize>], distances: &[Vec<f64>]) -> f64 {
    let asset_count = clusters.iter().map(Vec::len).sum::<usize>();
    if clusters.len() < 2 || asset_count == 0 {
        return 0.0;
    }
    let mut total = 0.0;
    for (cluster_index, cluster) in clusters.iter().enumerate() {
        for asset in cluster {
            if cluster.len() == 1 {
                continue;
            }
            let within = cluster
                .iter()
                .filter(|other| *other != asset)
                .map(|other| distances[*asset][*other])
                .sum::<f64>()
                / (cluster.len() - 1) as f64;
            let nearest = clusters
                .iter()
                .enumerate()
                .filter(|(other_index, _)| *other_index != cluster_index)
                .map(|(_, other)| {
                    other
                        .iter()
                        .map(|other_asset| distances[*asset][*other_asset])
                        .sum::<f64>()
                        / other.len().max(1) as f64
                })
                .fold(f64::INFINITY, f64::min);
            let scale = within.max(nearest);
            if scale > 1e-18 && nearest.is_finite() {
                total += (nearest - within) / scale;
            }
        }
    }
    total / asset_count as f64
}

/// Builds a deterministic flat cut of an average-linkage correlation-distance hierarchy.
///
/// HERC needs an explicit cluster cut before it can balance risk inside and between clusters.
/// We select the cut with the highest mean silhouette over every non-trivial dendrogram level;
/// exact-score ties prefer fewer clusters. This avoids a random reference distribution while
/// retaining the hierarchical structure and stable results for a fixed covariance matrix.
pub(super) fn herc_partition(covariance: &[Vec<f64>]) -> Option<Vec<Vec<usize>>> {
    let asset_count = covariance.len();
    if asset_count == 0
        || covariance
            .iter()
            .any(|row| row.len() != asset_count || row.iter().any(|value| !value.is_finite()))
    {
        return None;
    }
    if asset_count <= 2 {
        return Some((0..asset_count).map(|index| vec![index]).collect());
    }
    let distances = (0..asset_count)
        .map(|left| {
            (0..asset_count)
                .map(|right| herc_correlation_distance(covariance, left, right))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut clusters = (0..asset_count)
        .map(|index| vec![index])
        .collect::<Vec<_>>();
    let mut best_partition = None::<Vec<Vec<usize>>>;
    let mut best_score = f64::NEG_INFINITY;
    while clusters.len() > 2 {
        let mut best_pair = None::<(usize, usize, f64)>;
        for left in 0..clusters.len() {
            for right in left + 1..clusters.len() {
                let distance = herc_average_linkage(&clusters[left], &clusters[right], &distances);
                let replace = best_pair.is_none_or(|(best_left, best_right, best_distance)| {
                    distance.total_cmp(&best_distance) == Ordering::Less
                        || (distance.total_cmp(&best_distance) == Ordering::Equal
                            && (left, right) < (best_left, best_right))
                });
                if replace {
                    best_pair = Some((left, right, distance));
                }
            }
        }
        let (left, right, _) = best_pair?;
        let right_cluster = clusters.remove(right);
        clusters[left].extend(right_cluster);
        clusters[left].sort_unstable();
        clusters.sort();

        let score = herc_mean_silhouette(&clusters, &distances);
        let fewer_clusters = best_partition
            .as_ref()
            .is_some_and(|best| clusters.len() < best.len());
        if score > best_score + 1e-12 || ((score - best_score).abs() <= 1e-12 && fewer_clusters) {
            best_score = score;
            best_partition = Some(clusters.clone());
        }
    }
    best_partition.or(Some(clusters))
}

pub(super) fn covariance_submatrix(covariance: &[Vec<f64>], indices: &[usize]) -> Vec<Vec<f64>> {
    indices
        .iter()
        .map(|left| {
            indices
                .iter()
                .map(|right| covariance[*left][*right])
                .collect()
        })
        .collect()
}

pub(super) fn herc_cluster_covariance(
    covariance: &[Vec<f64>],
    clusters: &[Vec<usize>],
    within_weights: &[Vec<f64>],
) -> Vec<Vec<f64>> {
    let mut result = vec![vec![0.0; clusters.len()]; clusters.len()];
    for (left_cluster, left_assets) in clusters.iter().enumerate() {
        for (right_cluster, right_assets) in clusters.iter().enumerate() {
            for (left_position, left_asset) in left_assets.iter().enumerate() {
                for (right_position, right_asset) in right_assets.iter().enumerate() {
                    result[left_cluster][right_cluster] += within_weights[left_cluster]
                        [left_position]
                        * within_weights[right_cluster][right_position]
                        * covariance[*left_asset][*right_asset];
                }
            }
        }
    }
    result
}

/// Deterministic HERC-style allocation used by the optimizer baseline.
///
/// 1. Cluster assets with average-linkage correlation distance and a silhouette-selected cut.
/// 2. Solve equal-risk-contribution weights inside every cluster.
/// 3. Aggregate those fixed sub-portfolios into a cluster covariance matrix and solve ERC again
///    at the cluster level.
/// 4. Multiply cluster and member weights, then normalize long-only.
///
/// The optimizer's existing repair step subsequently applies asset/group/cardinality constraints.
pub(super) fn hierarchical_equal_risk_contribution(covariance: &[Vec<f64>]) -> Option<Vec<f64>> {
    let clusters = herc_partition(covariance)?;
    if clusters.is_empty() {
        return None;
    }
    let within_weights = clusters
        .iter()
        .map(|cluster| {
            if cluster.len() == 1 {
                Some(vec![1.0])
            } else {
                let submatrix = covariance_submatrix(covariance, cluster);
                portfolio_math::risk_parity(&submatrix)
                    .or_else(|| portfolio_math::inverse_volatility(&submatrix))
            }
        })
        .collect::<Option<Vec<_>>>()?;
    let cluster_covariance = herc_cluster_covariance(covariance, &clusters, &within_weights);
    let cluster_weights = portfolio_math::risk_parity(&cluster_covariance)
        .or_else(|| portfolio_math::inverse_volatility(&cluster_covariance))?;
    let mut weights = vec![0.0; covariance.len()];
    for (cluster_index, cluster) in clusters.iter().enumerate() {
        for (member_index, asset) in cluster.iter().enumerate() {
            weights[*asset] =
                cluster_weights[cluster_index] * within_weights[cluster_index][member_index];
        }
    }
    normalize_long_only(&weights)
}

pub(super) fn baseline_dense_weights(
    name: &str,
    frame: &Frame,
    covariance: &[Vec<f64>],
    constraints: &Constraints,
) -> Option<Vec<f64>> {
    match name {
        "equal_weight" => portfolio_math::equal_weight(frame.ids.len()),
        "current_weight" => normalize_long_only(
            &frame
                .ids
                .iter()
                .map(|id| constraints.current_weights.get(id).copied().unwrap_or(0.0))
                .collect::<Vec<_>>(),
        )
        .or_else(|| portfolio_math::equal_weight(frame.ids.len())),
        "inverse_volatility" => portfolio_math::inverse_volatility(covariance),
        "minimum_variance" => portfolio_math::minimum_variance(covariance),
        "risk_parity" => portfolio_math::risk_parity(covariance),
        "hrp" => portfolio_math::hrp(covariance),
        "herc" => hierarchical_equal_risk_contribution(covariance),
        _ => None,
    }
}

pub(super) fn baseline_candidates(
    frame: &Frame,
    covariance: &[Vec<f64>],
    config: &OptimizerV2Config,
    constraints: &Constraints,
) -> Vec<(Weights, String)> {
    config
        .baseline_names
        .iter()
        .filter_map(|name| {
            repair_dense_weights(
                &baseline_dense_weights(name, frame, covariance, constraints)?,
                &frame.ids,
                constraints,
                &config.group_constraints,
                &config.asset_groups,
            )
            .map(|weights| (weights, format!("baseline:{name}")))
        })
        .collect()
}

pub(super) fn random_dense_candidate(
    rng: &mut Mulberry32,
    frame: &Frame,
    constraints: &Constraints,
    config: &OptimizerV2Config,
) -> Option<Weights> {
    let raw = frame
        .ids
        .iter()
        .map(|_| -rng.next().max(f64::MIN_POSITIVE).ln())
        .collect::<Vec<_>>();
    repair_dense_weights(
        &raw,
        &frame.ids,
        constraints,
        &config.group_constraints,
        &config.asset_groups,
    )
}
