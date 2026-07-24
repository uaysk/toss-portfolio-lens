use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use super::input::{
    current_weight_map, decimal, numeric, object_number_map, positive_int, unique_strings,
};
use super::{Constraints, GroupConstraint, Mulberry32, Weights};

pub(super) fn normalize_constraints(
    raw: Option<&Value>,
    asset_count: usize,
) -> (Constraints, Vec<String>) {
    let raw = raw.and_then(Value::as_object);
    let get = |key| raw.and_then(|value| value.get(key));
    let mut warnings = Vec::new();
    let min_weight = decimal(get("minWeight"), 0.0, 0.0, 1.0);
    let mut max_weight = decimal(get("maxWeight"), 1.0, 0.0, 1.0);
    let mut max_assets = positive_int(
        get("maxAssets"),
        asset_count as u64,
        1,
        asset_count.max(1) as u64,
    ) as usize;
    if max_weight < min_weight {
        warnings
            .push("최대 비중이 최소 비중보다 작아 최소 비중을 최대 비중에 맞춥니다.".to_owned());
        max_weight = min_weight;
    }
    if max_assets > asset_count {
        max_assets = asset_count.max(1);
        warnings.push("최대 자산 수가 전체 후보 수보다 커서 전체 수로 보정했습니다.".to_owned());
    }

    let max_drawdown = numeric(get("maxDrawdown")).map(f64::abs).unwrap_or(1.0);
    let target_return = numeric(get("targetReturn")).unwrap_or(f64::NEG_INFINITY);
    let max_turnover = numeric(get("maxTurnover"))
        .map(|value| value.max(0.0))
        .unwrap_or(1.0);
    (
        Constraints {
            min_weight,
            max_weight,
            required_assets: unique_strings(get("requiredAssets")),
            excluded_assets: unique_strings(get("excludedAssets")),
            max_assets,
            min_weights: object_number_map(get("minWeights"), min_weight),
            max_weights: object_number_map(get("maxWeights"), max_weight),
            max_drawdown,
            target_return,
            max_turnover,
            current_weights: current_weight_map(get("currentWeights")),
        },
        warnings,
    )
}

pub(super) fn candidate_weights(
    rng: &mut Mulberry32,
    eligible: &[String],
    required: &[String],
    constraints: &Constraints,
) -> Option<Weights> {
    let mut required_set: HashSet<&str> = required.iter().map(String::as_str).collect();
    required_set.extend(
        constraints
            .min_weights
            .iter()
            .filter_map(|(key, minimum)| (*minimum > 0.0).then_some(key.as_str())),
    );
    let available: Vec<&String> = eligible
        .iter()
        .filter(|item| {
            !item.is_empty()
                && !constraints
                    .excluded_assets
                    .iter()
                    .any(|value| value == *item)
        })
        .collect();
    if available.is_empty() {
        return None;
    }
    let mandatory: Vec<&String> = available
        .iter()
        .copied()
        .filter(|item| required_set.contains(item.as_str()))
        .collect();
    if mandatory.len() > constraints.max_assets {
        return None;
    }
    let max_count = constraints.max_assets.min(available.len());
    let min_count = mandatory.len().max(1);
    let chosen_count = min_count + rng.next_int(max_count - min_count + 1);
    let mut candidate_ids = mandatory;
    let mut shuffled = available;
    for index in (1..shuffled.len()).rev() {
        let swap = rng.next_int(index + 1);
        shuffled.swap(index, swap);
    }
    for item in shuffled {
        if candidate_ids.contains(&item) {
            continue;
        }
        if candidate_ids.len() >= chosen_count {
            break;
        }
        candidate_ids.push(item);
    }
    if candidate_ids.is_empty() {
        return None;
    }

    let minimums: Vec<f64> = candidate_ids
        .iter()
        .map(|item| {
            constraints
                .min_weight
                .max(*constraints.min_weights.get(item.as_str()).unwrap_or(&0.0))
        })
        .collect();
    let maximums: Vec<f64> = candidate_ids
        .iter()
        .map(|item| {
            constraints
                .max_weight
                .min(*constraints.max_weights.get(item.as_str()).unwrap_or(&1.0))
        })
        .collect();
    if minimums
        .iter()
        .zip(&maximums)
        .any(|(minimum, maximum)| minimum > maximum)
    {
        return None;
    }
    let minimum_total: f64 = minimums.iter().sum();
    let maximum_total: f64 = maximums.iter().sum();
    if minimum_total > 1.0 + 1e-12 || maximum_total < 1.0 - 1e-12 {
        return None;
    }

    let mut values = minimums;
    let mut residual = 1.0 - minimum_total;
    for _ in 0..100 {
        if residual <= 1e-12 {
            break;
        }
        let active: Vec<usize> = (0..candidate_ids.len())
            .filter(|index| maximums[*index] - values[*index] > 1e-12)
            .collect();
        if active.is_empty() {
            return None;
        }
        let raw: Vec<f64> = active.iter().map(|_| 1.0 + rng.next()).collect();
        let raw_total: f64 = raw.iter().sum();
        let mut distributed = 0.0;
        for (raw_index, candidate_index) in active.into_iter().enumerate() {
            let capacity = maximums[candidate_index] - values[candidate_index];
            let addition = capacity.min(residual * raw[raw_index] / raw_total);
            values[candidate_index] += addition;
            distributed += addition;
        }
        if distributed <= 1e-14 {
            return None;
        }
        residual -= distributed;
    }
    if residual > 1e-9 {
        return None;
    }
    Some(Weights(
        candidate_ids
            .into_iter()
            .zip(values)
            .map(|(id, value)| (id.clone(), value))
            .collect(),
    ))
}

fn group_matches(
    id: &str,
    constraint: &GroupConstraint,
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    asset_groups
        .get(id)
        .and_then(|metadata| metadata.get(&constraint.dimension))
        .is_some_and(|group| group == &constraint.group)
}

pub(super) fn group_constraints_valid(
    weights: &Weights,
    group_constraints: &[GroupConstraint],
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    group_constraints.iter().all(|constraint| {
        let weight = weights
            .0
            .iter()
            .filter(|(id, _)| group_matches(id, constraint, asset_groups))
            .map(|(_, weight)| *weight)
            .sum::<f64>();
        weight + 1e-9 >= constraint.min_weight && weight <= constraint.max_weight + 1e-9
    })
}

pub(super) fn repair_dense_weights(
    raw: &[f64],
    ids: &[String],
    constraints: &Constraints,
    group_constraints: &[GroupConstraint],
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> Option<Weights> {
    if ids.is_empty() || raw.len() != ids.len() {
        return None;
    }
    let mut selected = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| !constraints.excluded_assets.contains(id))
        .map(|(index, id)| (index, raw[index].max(0.0), id))
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| right.1.total_cmp(&left.1).then_with(|| left.2.cmp(right.2)));
    let mut mandatory = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| {
            constraints.required_assets.contains(id)
                || constraints
                    .min_weights
                    .get(*id)
                    .is_some_and(|value| *value > 0.0)
        })
        .map(|(index, _)| index)
        .collect::<BTreeSet<_>>();
    for group_constraint in group_constraints {
        for (inside, required_capacity) in [
            (true, group_constraint.min_weight),
            (false, 1.0 - group_constraint.max_weight),
        ] {
            if required_capacity <= 1e-12 {
                continue;
            }
            let maximum = |index: usize| {
                constraints
                    .max_weight
                    .min(*constraints.max_weights.get(&ids[index]).unwrap_or(&1.0))
            };
            let belongs =
                |index: usize| group_matches(&ids[index], group_constraint, asset_groups) == inside;
            let mut capacity = mandatory
                .iter()
                .copied()
                .filter(|index| belongs(*index))
                .map(maximum)
                .sum::<f64>();
            let mut members = (0..ids.len())
                .filter(|index| {
                    !constraints.excluded_assets.contains(&ids[*index]) && belongs(*index)
                })
                .collect::<Vec<_>>();
            members.sort_by(|left, right| {
                raw[*right]
                    .total_cmp(&raw[*left])
                    .then_with(|| ids[*left].cmp(&ids[*right]))
            });
            for index in members {
                if capacity + 1e-10 >= required_capacity {
                    break;
                }
                if mandatory.insert(index) {
                    capacity += maximum(index);
                }
            }
            if capacity + 1e-10 < required_capacity {
                return None;
            }
        }
    }
    if mandatory.len() > constraints.max_assets {
        return None;
    }
    let mut active = mandatory;
    for (index, _, _) in selected {
        if active.len() >= constraints.max_assets {
            break;
        }
        active.insert(index);
    }
    if active.is_empty() {
        return None;
    }
    let lower = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            if active.contains(&index) {
                constraints
                    .min_weight
                    .max(*constraints.min_weights.get(id).unwrap_or(&0.0))
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let upper = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            if active.contains(&index) {
                constraints
                    .max_weight
                    .min(*constraints.max_weights.get(id).unwrap_or(&1.0))
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    if lower.iter().zip(&upper).any(|(left, right)| left > right)
        || lower.iter().sum::<f64>() > 1.0 + 1e-10
        || upper.iter().sum::<f64>() < 1.0 - 1e-10
    {
        return None;
    }
    let mut values = lower.clone();
    let mut remaining = 1.0 - values.iter().sum::<f64>();
    for _ in 0..64 {
        if remaining <= 1e-12 {
            break;
        }
        let available = (0..ids.len())
            .filter(|index| upper[*index] - values[*index] > 1e-12)
            .collect::<Vec<_>>();
        if available.is_empty() {
            return None;
        }
        let raw_total = available
            .iter()
            .map(|index| raw[*index].max(1e-9))
            .sum::<f64>();
        let mut distributed = 0.0;
        for index in available {
            let addition =
                (remaining * raw[index].max(1e-9) / raw_total).min(upper[index] - values[index]);
            values[index] += addition;
            distributed += addition;
        }
        if distributed <= 1e-14 {
            return None;
        }
        remaining -= distributed;
    }
    if remaining > 1e-9 {
        return None;
    }

    for _ in 0..24 {
        let mut changed = false;
        for constraint in group_constraints {
            let inside = ids
                .iter()
                .enumerate()
                .filter(|(_, id)| group_matches(id, constraint, asset_groups))
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let outside = (0..ids.len())
                .filter(|index| !inside.contains(index))
                .collect::<Vec<_>>();
            let total = inside.iter().map(|index| values[*index]).sum::<f64>();
            if total + 1e-10 < constraint.min_weight {
                let needed = constraint.min_weight - total;
                let receive_capacity = inside
                    .iter()
                    .map(|index| upper[*index] - values[*index])
                    .sum::<f64>();
                let donor_capacity = outside
                    .iter()
                    .map(|index| values[*index] - lower[*index])
                    .sum::<f64>();
                if receive_capacity + 1e-10 < needed || donor_capacity + 1e-10 < needed {
                    return None;
                }
                for index in &outside {
                    let capacity = values[*index] - lower[*index];
                    values[*index] -= needed * capacity / donor_capacity.max(1e-18);
                }
                for index in &inside {
                    let capacity = upper[*index] - values[*index];
                    values[*index] += needed * capacity / receive_capacity.max(1e-18);
                }
                changed = true;
            } else if total > constraint.max_weight + 1e-10 {
                let excess = total - constraint.max_weight;
                let donor_capacity = inside
                    .iter()
                    .map(|index| values[*index] - lower[*index])
                    .sum::<f64>();
                let receive_capacity = outside
                    .iter()
                    .map(|index| upper[*index] - values[*index])
                    .sum::<f64>();
                if donor_capacity + 1e-10 < excess || receive_capacity + 1e-10 < excess {
                    return None;
                }
                for index in &inside {
                    let capacity = values[*index] - lower[*index];
                    values[*index] -= excess * capacity / donor_capacity.max(1e-18);
                }
                for index in &outside {
                    let capacity = upper[*index] - values[*index];
                    values[*index] += excess * capacity / receive_capacity.max(1e-18);
                }
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let weights = Weights::from_dense(ids, &values);
    group_constraints_valid(&weights, group_constraints, asset_groups).then_some(weights)
}
