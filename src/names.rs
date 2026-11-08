pub const BASE_COLUMNS: [&str; 7] = ["type", "visit", "at", "page", "zone", "name", "country"];

const OBJECT_PROPERTIES: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

const TIME_AND_MEASURES: [&str; 5] = ["day", "week", "month", "records", "visits"];

pub const MAX_SEGMENTS: usize = 16;

pub const MAX_ORIGINS: usize = 32;

pub fn is_reserved(name: &str) -> bool {
    BASE_COLUMNS.contains(&name)
        || TIME_AND_MEASURES.contains(&name)
        || OBJECT_PROPERTIES.contains(&name)
}

pub fn reserved_names() -> impl Iterator<Item = &'static str> {
    BASE_COLUMNS
        .iter()
        .chain(TIME_AND_MEASURES.iter())
        .chain(OBJECT_PROPERTIES.iter())
        .copied()
}

pub fn is_app_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
        && bytes
            .iter()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

pub fn is_segment_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_alphabetic()
        && bytes.iter().all(u8::is_ascii_alphanumeric)
}

pub fn is_column_name(value: &str) -> bool {
    BASE_COLUMNS.contains(&value) || is_segment_name(value)
}

pub fn is_source(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_names() {
        assert!(is_app_name("myapp"));
        assert!(is_app_name("0-a"));
        assert!(!is_app_name("-a"));
        assert!(!is_app_name("Bad_Name"));
        assert!(!is_app_name(&"a".repeat(64)));
        assert!(is_segment_name("plan"));
        assert!(!is_segment_name("1plan"));
        assert!(!is_segment_name("a_b"));
        assert!(is_reserved("constructor"));
        assert!(is_reserved("week"));
        assert!(is_column_name("zone"));
        assert!(is_source("0123456789abcdef"));
        assert!(!is_source("0123456789ABCDEF"));
    }
}
