use anyhow::{Result, bail};

pub fn parse_iso_date(value: &str) -> Result<(i32, u32, u32)> {
    if value.len() != 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        bail!("invalid ISO date: {value}");
    }
    let year = value[0..4].parse::<i32>()?;
    let month = value[5..7].parse::<u32>()?;
    let day = value[8..10].parse::<u32>()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        bail!("invalid ISO date: {value}");
    }
    Ok((year, month, day))
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

pub fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

// Howard Hinnant's civil-date conversion, days relative to 1970-01-01.
pub fn epoch_day(value: &str) -> Result<i64> {
    let (mut year, month, day) = parse_iso_date(value)?;
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = month as i32 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day as i32 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Ok((era * 146_097 + day_of_era - 719_468) as i64)
}

pub fn days_between(from: &str, to: &str) -> i64 {
    match (epoch_day(from), epoch_day(to)) {
        (Ok(left), Ok(right)) => (right - left).max(0),
        _ => 0,
    }
}

pub fn year_month(value: &str) -> &str {
    &value[..7]
}

pub fn add_days(value: &str, days: i64) -> Result<String> {
    let target = epoch_day(value)? + days;
    Ok(civil_from_days(target))
}

pub fn civil_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_dates_and_offsets() {
        for value in ["1970-01-01", "2000-02-29", "2026-07-18", "2030-12-31"] {
            assert_eq!(civil_from_days(epoch_day(value).unwrap()), value);
        }
        assert_eq!(add_days("2024-02-28", 1).unwrap(), "2024-02-29");
        assert_eq!(days_between("2024-01-01", "2025-01-01"), 366);
    }
}
