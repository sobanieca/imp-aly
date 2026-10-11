use std::time::{SystemTime, UNIX_EPOCH};

pub const DAY_MS: i64 = 86_400_000;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let of_year = (153 * month_index + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_cycle - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let of_era = shifted - era * 146_097;
    let of_cycle = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let year = of_cycle + era * 400;
    let of_year = of_era - (365 * of_cycle + of_cycle / 4 - of_cycle / 100);
    let month_index = (5 * of_year + 2) / 153;
    let day = of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let rest = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

pub fn day_of(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(DAY_MS));
    format!("{year:04}-{month:02}-{day:02}")
}

fn number(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn civil_of(day: &str) -> Option<(i64, i64, i64)> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = number(&day[0..4])?;
    let month = number(&day[5..7])?;
    let date = number(&day[8..10])?;
    if !(1..=12).contains(&month) || date < 1 || date > days_in_month(year, month) {
        return None;
    }
    Some((year, month, date))
}

pub fn is_day(value: &str) -> bool {
    civil_of(value).is_some()
}

pub fn day_ms(day: &str) -> Option<i64> {
    let (year, month, date) = civil_of(day)?;
    Some(days_from_civil(year, month, date) * DAY_MS)
}

fn ms_of(day: &str) -> i64 {
    day_ms(day).unwrap_or(0)
}

pub fn parse_iso(text: &str) -> Option<i64> {
    let start = day_ms(text.get(0..10)?)?;
    let rest = text.get(10..)?;
    if rest.is_empty() {
        return Some(start);
    }
    let rest = rest.strip_prefix('T')?;
    let rest = rest.strip_suffix('Z')?;
    let (clock, fraction) = match rest.split_once('.') {
        Some((clock, fraction)) => (clock, fraction),
        None => (rest, ""),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|part| part.len() != 2) {
        return None;
    }
    let hours = number(parts[0])?;
    let minutes = number(parts[1])?;
    let seconds = parts.get(2).map_or(Some(0), |part| number(part))?;
    if hours > 23 || minutes > 59 || seconds > 59 {
        return None;
    }
    let millis = if fraction.is_empty() {
        0
    } else {
        let digits: String = fraction.chars().chain("00".chars()).take(3).collect();
        number(&digits)?
    };
    Some(start + hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis)
}

pub fn day_end_ms(day: &str) -> i64 {
    ms_of(day) + DAY_MS
}

pub fn week_of(day: &str) -> String {
    let time = ms_of(day);
    let weekday = (time.div_euclid(DAY_MS) + 3).rem_euclid(7);
    day_of(time - weekday * DAY_MS)
}

pub fn month_of(day: &str) -> String {
    day.get(0..7).unwrap_or(day).to_string()
}

pub fn add_days(day: &str, count: i64) -> String {
    day_of(ms_of(day) + count * DAY_MS)
}

pub fn add_months(day: &str, count: i64) -> String {
    let Some((year, month, date)) = civil_of(day) else {
        return day.to_string();
    };
    let index = year * 12 + (month - 1) + count;
    let target_year = index.div_euclid(12);
    let target_month = index.rem_euclid(12) + 1;
    let last = days_in_month(target_year, target_month);
    format!("{target_year:04}-{target_month:02}-{:02}", date.min(last))
}

pub fn day_count(from: &str, to: &str) -> i64 {
    (ms_of(to) - ms_of(from)) / DAY_MS + 1
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PeriodKind {
    Weeks,
    Months,
}

pub const PERIOD_KINDS: [PeriodKind; 2] = [PeriodKind::Weeks, PeriodKind::Months];

impl PeriodKind {
    pub fn dir(self) -> &'static str {
        match self {
            PeriodKind::Weeks => "weeks",
            PeriodKind::Months => "months",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            PeriodKind::Weeks => "week",
            PeriodKind::Months => "month",
        }
    }

    pub fn from_dir(text: &str) -> Option<Self> {
        match text {
            "weeks" => Some(PeriodKind::Weeks),
            "months" => Some(PeriodKind::Months),
            _ => None,
        }
    }
}

pub fn period_of(kind: PeriodKind, day: &str) -> String {
    match kind {
        PeriodKind::Weeks => week_of(day),
        PeriodKind::Months => month_of(day),
    }
}

pub fn is_period_id(kind: PeriodKind, id: &str) -> bool {
    match kind {
        PeriodKind::Weeks => is_day(id) && week_of(id) == id,
        PeriodKind::Months => {
            id.len() == 7
                && id.as_bytes()[4] == b'-'
                && id
                    .bytes()
                    .enumerate()
                    .all(|(at, byte)| at == 4 || byte.is_ascii_digit())
                && is_day(&format!("{id}-01"))
        }
    }
}

pub fn period_days(kind: PeriodKind, id: &str) -> Vec<String> {
    let first = match kind {
        PeriodKind::Weeks => id.to_string(),
        PeriodKind::Months => format!("{id}-01"),
    };
    let mut days = Vec::new();
    let mut time = ms_of(&first);
    loop {
        let day = day_of(time);
        if !days.is_empty() && period_of(kind, &day) != id {
            return days;
        }
        days.push(day);
        time += DAY_MS;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_count_in_utc() {
        assert_eq!(day_of(day_ms("2026-10-11").unwrap()), "2026-10-11");
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_760_189_820_123), "2025-10-11T13:37:00.123Z");
        assert_eq!(
            parse_iso("2025-10-11T13:37:00.123Z"),
            Some(1_760_189_820_123)
        );
        assert_eq!(parse_iso("2025-10-11T13:37:00Z"), Some(1_760_189_820_000));
        assert!(is_day("2024-02-29"));
        assert!(!is_day("2026-02-29"));
        assert!(!is_day("2026-13-01"));
        assert!(!is_day("2026-1-01"));
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(day_count("2026-09-01", "2026-09-30"), 30);
        assert_eq!(day_end_ms("1970-01-01"), DAY_MS);
    }

    #[test]
    fn a_month_back_keeps_the_day_or_takes_the_last_day_of_the_month() {
        assert_eq!(add_months("2026-03-31", -1), "2026-02-28");
        assert_eq!(add_months("2026-01-15", -3), "2025-10-15");
        assert_eq!(add_months("2024-03-30", -1), "2024-02-29");
        assert_eq!(add_months("2026-10-31", 1), "2026-11-30");
    }

    #[test]
    fn a_week_starts_on_monday_and_a_month_has_all_its_days() {
        assert_eq!(week_of("2026-10-11"), "2026-10-05");
        assert_eq!(week_of("2026-10-05"), "2026-10-05");
        assert!(is_period_id(PeriodKind::Weeks, "2026-10-05"));
        assert!(!is_period_id(PeriodKind::Weeks, "2026-10-06"));
        assert!(is_period_id(PeriodKind::Months, "2026-02"));
        assert!(!is_period_id(PeriodKind::Months, "2026-13"));
        assert_eq!(period_days(PeriodKind::Weeks, "2026-09-28").len(), 7);
        assert_eq!(period_days(PeriodKind::Months, "2024-02").len(), 29);
        assert_eq!(period_days(PeriodKind::Months, "2026-09")[29], "2026-09-30");
    }
}
