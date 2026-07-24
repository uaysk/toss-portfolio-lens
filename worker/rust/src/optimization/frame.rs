use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::Frame;
use super::input::{decimal, numeric, positive_int};

pub(super) fn walk_forward_config(config: Option<&Value>) -> (usize, usize, usize, usize, usize) {
    let config = config.and_then(Value::as_object);
    let get = |key| config.and_then(|value| value.get(key));
    let train = positive_int(get("trainWindow"), 126, 2, 10_000) as usize;
    let test = positive_int(get("testWindow"), 21, 1, 10_000) as usize;
    let step = positive_int(get("step"), test.max(1) as u64, 1, 10_000) as usize;
    let minimum_train = positive_int(
        get("minimumTrainObservations"),
        (train / 2).max(2) as u64,
        1,
        train as u64,
    ) as usize;
    let minimum_test = positive_int(
        get("minimumTestObservations"),
        (test / 2).max(1) as u64,
        1,
        test as u64,
    ) as usize;
    (train, test, step.max(1), minimum_train, minimum_test)
}

pub fn build_walk_forward_windows(total_length: usize, config: Option<&Value>) -> Vec<Value> {
    let safe_length = total_length.min(10_000_000);
    let config_object = config.and_then(Value::as_object);
    if config_object
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Vec::new();
    }
    if config_object
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        == Some("holdout")
    {
        let minimum_train = positive_int(
            config_object.and_then(|value| value.get("minimumTrainObservations")),
            20,
            2,
            10_000,
        ) as usize;
        let minimum_test = positive_int(
            config_object.and_then(|value| value.get("minimumTestObservations")),
            5,
            1,
            10_000,
        ) as usize;
        let gap = positive_int(
            config_object.and_then(|value| value.get("gap")),
            0,
            0,
            10_000,
        ) as usize;
        if safe_length < minimum_train + minimum_test + gap {
            return Vec::new();
        }
        let train_fraction = decimal(
            config_object.and_then(|value| value.get("trainFraction")),
            0.8,
            0.1,
            0.95,
        );
        let test_fraction = decimal(
            config_object.and_then(|value| value.get("testFraction")),
            0.2,
            0.05,
            0.5,
        );
        let available = safe_length - gap;
        let requested_test = ((safe_length as f64 * test_fraction).round() as usize)
            .clamp(minimum_test, available - minimum_train);
        let test_start = safe_length - requested_test;
        let test_end = safe_length - 1;
        let train_end = test_start - gap - 1;
        let maximum_train = train_end + 1;
        let requested_train = ((safe_length as f64 * train_fraction).round() as usize)
            .clamp(minimum_train, maximum_train);
        let train_start = maximum_train - requested_train;
        return vec![json!({
            "foldIndex": 0,
            "trainStartIndex": train_start,
            "trainEndIndex": train_end,
            "testStartIndex": test_start,
            "testEndIndex": test_end,
            "trainStart": format!("index-{train_start}"),
            "trainEnd": format!("index-{train_end}"),
            "testStart": format!("index-{test_start}"),
            "testEnd": format!("index-{test_end}"),
            "trainCount": requested_train,
            "testCount": requested_test,
            "gap": gap,
            "embargo": 0,
            "mode": "holdout",
        })];
    }
    let (train, test, step, minimum_train, minimum_test) = walk_forward_config(config);
    let gap = positive_int(
        config_object.and_then(|value| value.get("gap")),
        0,
        0,
        10_000,
    ) as usize;
    let embargo = positive_int(
        config_object.and_then(|value| value.get("embargo")),
        0,
        0,
        10_000,
    ) as usize;
    let requested_folds = positive_int(
        config_object.and_then(|value| value.get("foldCount")),
        5,
        2,
        100,
    ) as usize;
    let window_mode = config_object
        .and_then(|value| value.get("windowMode"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "rolling" | "anchored"))
        .unwrap_or("rolling");
    // Do not allow overlapping OOS windows. Embargo is measured from the end of
    // the previous test window to the beginning of the next one.
    let advance = step.max(test.saturating_add(embargo)).max(1);
    let mut windows = Vec::new();
    if safe_length == 0 {
        return windows;
    }

    let mut offset = 0usize;
    while windows.len() < requested_folds {
        let train_start = if window_mode == "anchored" { 0 } else { offset };
        let Some(train_end) = offset
            .checked_add(train)
            .and_then(|value| value.checked_sub(1))
        else {
            break;
        };
        let Some(test_start) = train_end
            .checked_add(1)
            .and_then(|value| value.checked_add(gap))
        else {
            break;
        };
        let Some(test_end) = test_start
            .checked_add(test)
            .and_then(|value| value.checked_sub(1))
        else {
            break;
        };
        if test_end >= safe_length {
            break;
        }
        let train_count = train_end - train_start + 1;
        let test_count = test_end - test_start + 1;
        if train_count >= minimum_train && test_count >= minimum_test {
            windows.push(json!({
                "foldIndex": windows.len(),
                "trainStartIndex": train_start,
                "trainEndIndex": train_end,
                "testStartIndex": test_start,
                "testEndIndex": test_end,
                "trainStart": format!("index-{train_start}"),
                "trainEnd": format!("index-{train_end}"),
                "testStart": format!("index-{test_start}"),
                "testEnd": format!("index-{test_end}"),
                "trainCount": train_count,
                "testCount": test_count,
                "gap": gap,
                "embargo": embargo,
                "advance": advance,
                "mode": "walk_forward",
                "windowMode": window_mode,
            }));
        }
        let Some(next_offset) = offset.checked_add(advance) else {
            break;
        };
        offset = next_offset;
    }
    windows
}

pub(super) fn training_frame(frame: &Frame, windows: &[Value]) -> Frame {
    let Some(first) = windows.first() else {
        return frame.clone();
    };
    let start = first
        .get("trainStartIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let end = first
        .get("trainEndIndex")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or_else(|| frame.dates.len().saturating_sub(1));
    if start > end || start >= frame.dates.len() {
        return frame.clone();
    }
    let end = end.min(frame.dates.len().saturating_sub(1));
    Frame {
        ids: frame.ids.clone(),
        dates: frame.dates[start..=end].to_vec(),
        returns: frame.returns[start..=end].to_vec(),
    }
}

fn valid_date(value: &str) -> bool {
    crate::date::parse_iso_date(value).is_ok()
}

pub(super) fn sanitize_points(value: Option<&Value>, positive_only: bool) -> BTreeMap<String, f64> {
    let mut by_date = BTreeMap::new();
    for point in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(point) = point.as_object() else {
            continue;
        };
        let Some(date) = point.get("date").and_then(Value::as_str) else {
            continue;
        };
        let Some(number) = numeric(point.get("value")) else {
            continue;
        };
        if !valid_date(date) || (positive_only && number <= 0.0) {
            continue;
        }
        by_date.insert(date.to_owned(), number);
    }
    by_date
}

pub(super) fn aligned_frame(price_series: &[Value]) -> Frame {
    let mut returns_by_id: Vec<(String, BTreeMap<String, f64>)> = Vec::new();
    for series in price_series {
        let object = series.as_object();
        let id = object
            .and_then(|value| value.get("key"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let points = sanitize_points(object.and_then(|value| value.get("points")), true);
        let entries: Vec<_> = points.into_iter().collect();
        let mut returns = BTreeMap::new();
        for pair in entries.windows(2) {
            let value = pair[1].1 / pair[0].1 - 1.0;
            if value.is_finite() {
                returns.insert(pair[1].0.clone(), value);
            }
        }
        returns_by_id.push((id, returns));
    }

    let dates = returns_by_id
        .first()
        .map(|(_, first)| {
            first
                .keys()
                .filter(|date| {
                    returns_by_id
                        .iter()
                        .all(|(_, values)| values.contains_key(*date))
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let returns = dates
        .iter()
        .map(|date| {
            returns_by_id
                .iter()
                .map(|(_, values)| values[date])
                .collect()
        })
        .collect();
    Frame {
        ids: returns_by_id.into_iter().map(|(id, _)| id).collect(),
        dates,
        returns,
    }
}
