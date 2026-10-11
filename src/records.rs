use crate::app_build::Lists;
use crate::json::{Object, Value, format_number, is_safe_integer};

pub const MAX_RECORD_AGE_MS: i64 = 3_600_000;

pub const DEFAULT_SEAL_DELAY_MS: i64 = MAX_RECORD_AGE_MS + 600_000;

pub const MAX_RECORD_AHEAD_MS: i64 = 3_600_000;

const MAX_NAME_LENGTH: usize = 128;

const MAX_PATTERN_LENGTH: usize = 512;

pub const TYPES: [&str; 5] = ["page", "seen", "used", "outcome", "error"];

fn type_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "seen" | "used" => &["zone"],
        "outcome" => &["name"],
        _ => &[],
    }
}

const COMMON_FIELDS: [&str; 4] = ["type", "visit", "at", "page"];

pub fn is_type(value: &str) -> bool {
    TYPES.contains(&value)
}

fn is_name_part(part: &str) -> bool {
    !part.is_empty()
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn is_name(value: &str) -> bool {
    if value.len() > MAX_NAME_LENGTH {
        return false;
    }
    let mut parts = value.split('.');
    parts.next().is_some_and(is_name_part) && {
        let rest: Vec<&str> = parts.collect();
        !rest.is_empty() && rest.iter().all(|part| is_name_part(part))
    }
}

pub fn is_segment_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn is_country(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 2
        && bytes[0].is_ascii_uppercase()
        && (bytes[1].is_ascii_uppercase() || bytes[1].is_ascii_digit())
}

fn is_visit(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn has_control_character(text: &str) -> bool {
    text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

pub fn is_safe_text(value: &str) -> bool {
    !has_control_character(value)
}

pub fn is_route_pattern(value: &str) -> bool {
    value.starts_with('/')
        && value.encode_utf16().count() <= MAX_PATTERN_LENGTH
        && is_safe_text(value)
}

pub fn normalize_country(value: Option<&str>) -> Option<String> {
    let country = value.unwrap_or("").trim().to_uppercase();
    is_country(&country).then_some(country)
}

enum Segment {
    Empty,
    Text(String),
    Problem(&'static str),
}

fn segment_value(value: &Value) -> Segment {
    match value {
        Value::Null => Segment::Empty,
        Value::String(text) if text.is_empty() => Segment::Empty,
        Value::Number(number) if !number.is_finite() => Segment::Problem("not a finite number"),
        Value::Number(number) => check_segment(format_number(*number)),
        Value::Bool(flag) => check_segment(flag.to_string()),
        Value::String(text) => check_segment(text.clone()),
        _ => Segment::Problem("not a text of 1 to 64 letters, digits, \".\", \"-\" or \"_\""),
    }
}

fn check_segment(text: String) -> Segment {
    if is_segment_value(&text) {
        Segment::Text(text)
    } else {
        Segment::Problem("not a text of 1 to 64 letters, digits, \".\", \"-\" or \"_\"")
    }
}

pub fn validate_record(
    input: &Value,
    lists: &Lists,
    segments: &[String],
    country: Option<&str>,
    now: i64,
) -> Result<Object, String> {
    let Value::Object(input) = input else {
        return Err("record is not an object".to_string());
    };
    let kind = match input.get("type") {
        Some(Value::String(kind)) if is_type(kind) => kind.as_str(),
        _ => return Err("type is not one of page, seen, used, outcome, error".to_string()),
    };
    for key in input.keys() {
        let allowed = COMMON_FIELDS.contains(&key.as_str())
            || type_fields(kind).contains(&key.as_str())
            || segments.iter().any(|segment| segment == key);
        if !allowed {
            let short: String = key.chars().take(40).collect();
            return Err(format!("field \"{short}\" is not allowed"));
        }
    }
    let visit = match input.get("visit") {
        Some(Value::String(visit)) if is_visit(visit) => visit.clone(),
        _ => {
            return Err(
                "visit is not an id of 1 to 64 letters, digits, \"-\" or \"_\"".to_string(),
            );
        }
    };
    let at = match input.get("at") {
        Some(Value::Number(at)) if is_safe_integer(*at) && *at > 0.0 => *at as i64,
        _ => return Err("at is not a time in milliseconds".to_string()),
    };
    if at < now - MAX_RECORD_AGE_MS {
        return Err("at is more than 1 hour old".to_string());
    }
    if at > now + MAX_RECORD_AHEAD_MS {
        return Err("at is more than 1 hour ahead".to_string());
    }
    let page = match input.get("page") {
        Some(Value::String(page)) if lists.pages.contains(page) => page.clone(),
        _ => return Err("page is not in the pages of app-analytics.json".to_string()),
    };
    let mut record = Object::new()
        .with("type", kind)
        .with("visit", visit)
        .with("at", at)
        .with("page", page);
    match kind {
        "seen" => {
            let zone = match input.get("zone") {
                Some(Value::String(zone)) if is_name(zone) => zone,
                _ => return Err("zone is not a namespaced name".to_string()),
            };
            if !lists.zones.contains(zone) {
                return Err("zone is not in the zones of app-analytics.json".to_string());
            }
            record.insert("zone", zone.clone());
        }
        "used" => match input.get("zone") {
            None => return Err("zone is missing".to_string()),
            Some(Value::Null) => {}
            Some(Value::String(zone)) if is_name(zone) => {
                if !lists.zones.contains(zone) {
                    return Err("zone is not in the zones of app-analytics.json".to_string());
                }
                record.insert("zone", zone.clone());
            }
            Some(_) => return Err("zone is not a namespaced name or null".to_string()),
        },
        "outcome" => {
            let name = match input.get("name") {
                Some(Value::String(name)) if is_name(name) => name,
                _ => return Err("name is not a namespaced name".to_string()),
            };
            if !lists.outcomes.contains(name) {
                return Err("name is not in the outcomes of app-analytics.json".to_string());
            }
            record.insert("name", name.clone());
        }
        _ => {}
    }
    if let Some(country) = country {
        record.insert("country", country);
    }
    for segment in segments {
        let Some(value) = input.get(segment) else {
            continue;
        };
        match segment_value(value) {
            Segment::Empty => {}
            Segment::Text(text) => record.insert(segment.clone(), text),
            Segment::Problem(problem) => {
                return Err(format!("segment \"{segment}\" is {problem}"));
            }
        }
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{parse, stringify};

    fn lists() -> Lists {
        Lists {
            pages: ["/", "/invoices/:id"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            zones: ["myapp.send", "my_app.Zone-2.a"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            outcomes: [
                "myapp.sent".to_string(),
                format!("myapp.{}", "x".repeat(122)),
            ]
            .into_iter()
            .collect(),
        }
    }

    const NOW: i64 = 1_759_300_006_100;

    fn check(extra: &str) -> Result<String, String> {
        check_with(extra, None)
    }

    fn check_with(extra: &str, country: Option<&str>) -> Result<String, String> {
        let text = format!(
            r#"{{"visit":"k3v9a1c2","at":{NOW},"page":"/invoices/:id"{}{extra}}}"#,
            if extra.is_empty() { "" } else { "," }
        );
        validate_record(
            &parse(&text).unwrap(),
            &lists(),
            &["plan".to_string()],
            country,
            NOW,
        )
        .map(|record| stringify(&Value::Object(record)))
    }

    #[test]
    fn accepts_each_record_type_of_imp() {
        assert_eq!(
            check(r#""type":"page""#).unwrap(),
            format!(r#"{{"type":"page","visit":"k3v9a1c2","at":{NOW},"page":"/invoices/:id"}}"#)
        );
        assert!(check(r#""type":"seen","zone":"myapp.send""#).is_ok());
        assert_eq!(
            check(r#""type":"used","zone":null"#).unwrap(),
            format!(r#"{{"type":"used","visit":"k3v9a1c2","at":{NOW},"page":"/invoices/:id"}}"#)
        );
        assert!(check(r#""type":"outcome","name":"myapp.sent""#).is_ok());
        assert!(check(r#""type":"error""#).is_ok());
    }

    #[test]
    fn keeps_declared_segments_and_the_country() {
        assert_eq!(
            check_with(r#""type":"error","plan":"pro""#, Some("PL")).unwrap(),
            format!(
                r#"{{"type":"error","visit":"k3v9a1c2","at":{NOW},"page":"/invoices/:id","country":"PL","plan":"pro"}}"#
            )
        );
        assert!(
            !check(r#""type":"error","plan":null"#)
                .unwrap()
                .contains("plan")
        );
        assert!(
            check(r#""type":"error","plan":3"#)
                .unwrap()
                .contains(r#""plan":"3""#)
        );
        for (value, text) in [
            ("-1", "-1"),
            ("0.5", "0.5"),
            ("true", "true"),
            ("\"en-US\"", "en-US"),
        ] {
            assert!(
                check(&format!(r#""type":"error","plan":{value}"#))
                    .unwrap()
                    .contains(&format!(r#""plan":"{text}""#))
            );
        }
    }

    #[test]
    fn rejects_malformed_records() {
        let problems = [
            (
                r#""type":"click""#,
                "type is not one of page, seen, used, outcome, error",
            ),
            (
                r#""type":"page","extra":1"#,
                "field \"extra\" is not allowed",
            ),
            (
                r#""type":"page","zone":"myapp.send""#,
                "field \"zone\" is not allowed",
            ),
            (
                r#""type":"seen","zone":"nodot""#,
                "zone is not a namespaced name",
            ),
            (
                r#""type":"seen","zone":"myapp.other""#,
                "zone is not in the zones of app-analytics.json",
            ),
            (r#""type":"used""#, "zone is missing"),
            (
                r#""type":"used","zone":5"#,
                "zone is not a namespaced name or null",
            ),
            (
                r#""type":"outcome","name":"a.b""#,
                "name is not in the outcomes of app-analytics.json",
            ),
            (
                r#""type":"error","plan":"a b""#,
                "segment \"plan\" is not a text of 1 to 64 letters, digits, \".\", \"-\" or \"_\"",
            ),
            (
                r#""type":"error","plan":[]"#,
                "segment \"plan\" is not a text of 1 to 64 letters, digits, \".\", \"-\" or \"_\"",
            ),
        ];
        for (extra, problem) in problems {
            assert_eq!(check(extra).unwrap_err(), problem, "{extra}");
        }
        let at = |value: &str| {
            let text = format!(r#"{{"type":"page","visit":"v","at":{value},"page":"/"}}"#);
            validate_record(&parse(&text).unwrap(), &lists(), &[], None, NOW).unwrap_err()
        };
        assert_eq!(at("1.5"), "at is not a time in milliseconds");
        assert_eq!(at("0"), "at is not a time in milliseconds");
        assert_eq!(
            at(&(NOW - 3_600_001).to_string()),
            "at is more than 1 hour old"
        );
        assert_eq!(
            at(&(NOW + 3_600_001).to_string()),
            "at is more than 1 hour ahead"
        );
        assert_eq!(
            validate_record(&parse("[]").unwrap(), &lists(), &[], None, NOW).unwrap_err(),
            "record is not an object"
        );
    }

    #[test]
    fn normalizes_the_country_header() {
        assert_eq!(normalize_country(Some(" pl ")), Some("PL".to_string()));
        assert_eq!(normalize_country(Some("A1")), Some("A1".to_string()));
        assert_eq!(normalize_country(Some("POL")), None);
        assert_eq!(normalize_country(Some("1A")), None);
        assert_eq!(normalize_country(None), None);
        assert!(is_name("my_app.Zone-2.a"));
        assert!(!is_name("myapp."));
    }
}
