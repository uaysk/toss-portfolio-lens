use anyhow::Result;
use serde_json::Value;

use crate::control::{ComputeControl, checkpoint};

use super::as_metric;

#[derive(Debug, Clone, Copy)]
pub(super) struct ParetoPoint {
    /// Every value is transformed so a larger value is preferable.
    values: [Option<f64>; 6],
}

impl ParetoPoint {
    pub(super) fn from_candidate(candidate: &Value) -> Self {
        Self {
            values: [
                as_metric(candidate, "return"),
                as_metric(candidate, "volatility").map(|value| -value),
                as_metric(candidate, "maxDrawdown").map(|value| -value.abs()),
                as_metric(candidate, "cvar").map(|value| -value.abs()),
                as_metric(candidate, "turnover").map(|value| -value),
                as_metric(candidate, "transactionCost").map(|value| -value),
            ],
        }
    }

    fn is_complete(self) -> bool {
        self.values.iter().all(Option::is_some)
    }
}

pub(super) fn typed_dominates(left: ParetoPoint, right: ParetoPoint) -> bool {
    let mut comparable = 0usize;
    let mut strictly_better = false;
    for (left, right) in left.values.into_iter().zip(right.values) {
        let (Some(left), Some(right)) = (left, right) else {
            continue;
        };
        comparable += 1;
        if left < right {
            return false;
        }
        strictly_better |= left > right;
    }
    comparable > 0 && strictly_better
}

fn pareto_indices(
    points: &[ParetoPoint],
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<usize>> {
    if points.iter().all(|point| point.is_complete()) {
        let mut frontier = Vec::<usize>::new();
        for (index, candidate) in points.iter().copied().enumerate() {
            if index.is_multiple_of(256) {
                checkpoint(control)?;
            }
            if frontier
                .iter()
                .any(|other| typed_dominates(points[*other], candidate))
            {
                continue;
            }
            frontier.retain(|other| !typed_dominates(candidate, points[*other]));
            frontier.push(index);
        }
        return Ok(frontier);
    }

    // Missing metrics make the legacy pairwise relation non-transitive. Retain exact historical
    // semantics for those uncommon candidates while still avoiding repeated JSON traversal.
    let mut frontier = Vec::new();
    for (index, candidate) in points.iter().copied().enumerate() {
        if index.is_multiple_of(128) {
            checkpoint(control)?;
        }
        let dominated = points
            .iter()
            .copied()
            .enumerate()
            .any(|(other, point)| other != index && typed_dominates(point, candidate));
        if !dominated {
            frontier.push(index);
        }
    }
    Ok(frontier)
}

pub fn pareto(candidates: &[Value]) -> Vec<Value> {
    let points = candidates
        .iter()
        .map(ParetoPoint::from_candidate)
        .collect::<Vec<_>>();
    pareto_indices(&points, None)
        .expect("pareto without a control cannot be cancelled")
        .into_iter()
        .map(|index| candidates[index].clone())
        .collect()
}

pub(super) fn pareto_with_control(
    candidates: &[Value],
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Value>> {
    let points = candidates
        .iter()
        .map(ParetoPoint::from_candidate)
        .collect::<Vec<_>>();
    Ok(pareto_indices(&points, control)?
        .into_iter()
        .map(|index| candidates[index].clone())
        .collect())
}
