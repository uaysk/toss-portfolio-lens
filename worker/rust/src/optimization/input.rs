use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

pub(super) fn numeric(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(value) => value.parse::<f64>().ok().filter(|value| value.is_finite()),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        _ => None,
    }
}

pub(super) fn positive_int(
    value: Option<&Value>,
    fallback: u64,
    minimum: u64,
    maximum: u64,
) -> u64 {
    let Some(value) = numeric(value) else {
        return fallback;
    };
    (value.floor().max(minimum as f64).min(maximum as f64)) as u64
}

pub(super) fn decimal(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    numeric(value).unwrap_or(fallback).clamp(minimum, maximum)
}

pub(super) fn object_number_map(value: Option<&Value>, fallback: f64) -> BTreeMap<String, f64> {
    value
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        numeric(Some(value)).unwrap_or(fallback).clamp(0.0, 1.0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn current_weight_map(value: Option<&Value>) -> BTreeMap<String, f64> {
    value
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| numeric(Some(value)).map(|number| (key.clone(), number)))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn unique_strings(value: Option<&Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .filter(|item| seen.insert((*item).to_owned()))
        .map(str::to_owned)
        .collect()
}
