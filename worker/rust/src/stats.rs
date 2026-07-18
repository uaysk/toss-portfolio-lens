pub fn round(value: f64, digits: u32) -> f64 {
    let scale = 10_f64.powi(digits as i32);
    let result = (value * scale + 0.5).floor() / scale;
    if result == 0.0 { 0.0 } else { result }
}

pub fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

pub fn sample_std(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mean = average(values);
    (values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (values.len() - 1) as f64)
        .sqrt()
}

pub fn covariance(left: &[f64], right: &[f64]) -> f64 {
    let length = left.len().min(right.len());
    if length < 2 {
        return 0.0;
    }
    let left = &left[..length];
    let right = &right[..length];
    let left_mean = average(left);
    let right_mean = average(right);
    left.iter()
        .zip(right)
        .map(|(l, r)| (l - left_mean) * (r - right_mean))
        .sum::<f64>()
        / (length - 1) as f64
}

pub fn correlation(left: &[f64], right: &[f64]) -> Option<f64> {
    let denominator = sample_std(left) * sample_std(right);
    (denominator > 0.0).then(|| round(covariance(left, right) / denominator, 4))
}

pub fn compounded_return(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| {
        values
            .iter()
            .fold(1.0, |growth, value| growth * (1.0 + value))
            - 1.0
    })
}

pub fn percentile_linear(values: &[f64], probability: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = probability.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    let fraction = index - lower as f64;
    Some(sorted[lower] * (1.0 - fraction) + sorted[upper] * fraction)
}

pub fn percentile_nearest_rank(values: &[f64], probability: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 * probability).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    Some(sorted[index])
}

pub fn xirr(flows: &[(String, f64)]) -> Option<f64> {
    if flows.len() < 2
        || !flows.iter().any(|(_, amount)| *amount < 0.0)
        || !flows.iter().any(|(_, amount)| *amount > 0.0)
    {
        return None;
    }
    let start = &flows[0].0;
    let npv = |rate: f64| -> f64 {
        flows
            .iter()
            .map(|(date, amount)| {
                // Excel/Google Sheets XIRR use an actual-day count over a fixed 365-day year.
                let years = crate::date::days_between(start, date) as f64 / 365.0;
                amount / (1.0 + rate).powf(years)
            })
            .sum()
    };
    let mut low = -0.999_999;
    let mut high = 1.0;
    let mut low_value = npv(low);
    let mut high_value = npv(high);
    for _ in 0..64 {
        if low_value.is_finite()
            && high_value.is_finite()
            && low_value.signum() != high_value.signum()
        {
            break;
        }
        high = high * 2.0 + 1.0;
        high_value = npv(high);
    }
    if !low_value.is_finite()
        || !high_value.is_finite()
        || low_value.signum() == high_value.signum()
    {
        return None;
    }
    for _ in 0..200 {
        let middle = (low + high) / 2.0;
        let value = npv(middle);
        if !value.is_finite() {
            return None;
        }
        if value.abs() < 1e-10 {
            return Some(middle);
        }
        if value.signum() == low_value.signum() {
            low = middle;
            low_value = value;
        } else {
            high = middle;
        }
    }
    Some((low + high) / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xirr_matches_known_one_year_return() {
        let rate = xirr(&[("2024-01-01".into(), -100.0), ("2025-01-01".into(), 110.0)]).unwrap();
        assert!((rate - 0.099_713_586).abs() < 0.000_000_1);
    }
}
