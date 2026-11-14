use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;

pub const DEFAULT_DEDUPE: &str = "8h";

pub const DEFAULT_DEDUPE_MS: u64 = 8 * 3_600_000;

pub const DEFAULT_MAX_VIEWS: usize = 1_000_000;

const MAX_DEDUPE_MS: u64 = 7 * 86_400_000;

const UNITS: [(char, u64); 4] = [
    ('s', 1_000),
    ('m', 60_000),
    ('h', 3_600_000),
    ('d', 86_400_000),
];

pub fn parse_dedupe(text: &str) -> std::result::Result<Option<u64>, String> {
    let value = text.trim().to_ascii_lowercase();
    if value == "off" {
        return Ok(None);
    }
    let problem =
        || format!("--dedupe \"{text}\" is not a time like 30m, 8h or 1d, or off - the most is 7d");
    let unit = value.chars().last().ok_or_else(problem)?;
    let (_, size) = UNITS
        .iter()
        .find(|(name, _)| *name == unit)
        .ok_or_else(problem)?;
    let digits = &value[..value.len() - 1];
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(problem());
    }
    let amount: u64 = digits.parse().map_err(|_| problem())?;
    match amount.checked_mul(*size) {
        Some(ms) if ms > 0 && ms <= MAX_DEDUPE_MS => Ok(Some(ms)),
        _ => Err(problem()),
    }
}

#[derive(Clone, Copy)]
struct View {
    visit: u64,
    at: u64,
}

pub struct Dedupe {
    window_ms: Option<u64>,
    generation: usize,
    hasher: RandomState,
    recent: HashMap<u64, View>,
    older: HashMap<u64, View>,
}

impl Dedupe {
    pub fn new(window_ms: Option<u64>, max_views: usize) -> Self {
        Dedupe {
            window_ms,
            generation: max_views.div_ceil(2).max(1),
            hasher: RandomState::new(),
            recent: HashMap::new(),
            older: HashMap::new(),
        }
    }

    fn find(&mut self, key: u64) -> Option<View> {
        if let Some(view) = self.recent.get(&key) {
            return Some(*view);
        }
        let view = self.older.remove(&key)?;
        self.insert(key, view);
        Some(view)
    }

    fn insert(&mut self, key: u64, view: View) {
        if !self.recent.contains_key(&key) && self.recent.len() >= self.generation {
            self.older = std::mem::take(&mut self.recent);
        }
        self.recent.insert(key, view);
    }

    pub fn admit(&mut self, app: &str, client: &str, page: &str, visit: &str, now: u64) -> bool {
        let Some(window_ms) = self.window_ms else {
            return true;
        };
        let key = self.hasher.hash_one((app, client, page));
        let visit = self.hasher.hash_one(visit);
        if let Some(view) = self.find(key)
            && now.saturating_sub(view.at) < window_ms
        {
            return view.visit == visit;
        }
        self.insert(key, View { visit, at: now });
        true
    }

    pub fn size(&self) -> usize {
        self.recent.len() + self.older.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600_000;

    #[test]
    fn parses_a_window_or_off() {
        assert_eq!(parse_dedupe("8h"), Ok(Some(8 * HOUR)));
        assert_eq!(parse_dedupe(DEFAULT_DEDUPE), Ok(Some(DEFAULT_DEDUPE_MS)));
        assert_eq!(parse_dedupe(" 30M "), Ok(Some(30 * 60_000)));
        assert_eq!(parse_dedupe("1d"), Ok(Some(24 * HOUR)));
        assert_eq!(parse_dedupe("45s"), Ok(Some(45_000)));
        assert_eq!(parse_dedupe("7d"), Ok(Some(7 * 24 * HOUR)));
        assert_eq!(parse_dedupe("off"), Ok(None));
        for bad in [
            "",
            "8",
            "h",
            "0h",
            "8x",
            "-1h",
            "1.5h",
            "8d",
            "99999999999999999999h",
        ] {
            assert!(parse_dedupe(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_first_visit_of_a_page_and_address_owns_the_window() {
        let mut dedupe = Dedupe::new(Some(8 * HOUR), 100);
        assert!(dedupe.admit("blog", "1.2.3.4", "/a", "v1", 0));
        assert!(dedupe.admit("blog", "1.2.3.4", "/a", "v1", HOUR));
        assert!(!dedupe.admit("blog", "1.2.3.4", "/a", "v2", HOUR));
        assert!(dedupe.admit("blog", "1.2.3.4", "/b", "v2", HOUR));
        assert!(dedupe.admit("blog", "5.6.7.8", "/a", "v3", HOUR));
        assert!(dedupe.admit("shop", "1.2.3.4", "/a", "v2", HOUR));
        assert!(!dedupe.admit("blog", "1.2.3.4", "/a", "v2", 8 * HOUR - 1));
        assert!(dedupe.admit("blog", "1.2.3.4", "/a", "v2", 8 * HOUR));
        assert!(!dedupe.admit("blog", "1.2.3.4", "/a", "v1", 8 * HOUR + 1));
    }

    #[test]
    fn off_admits_every_record_and_keeps_nothing() {
        let mut dedupe = Dedupe::new(None, 100);
        assert!(dedupe.admit("blog", "1.2.3.4", "/a", "v1", 0));
        assert!(dedupe.admit("blog", "1.2.3.4", "/a", "v2", 0));
        assert_eq!(dedupe.size(), 0);
    }

    #[test]
    fn the_memory_keeps_two_generations_of_views() {
        let mut dedupe = Dedupe::new(Some(8 * HOUR), 4);
        assert!(dedupe.admit("blog", "1.1.1.1", "/", "v1", 0));
        assert!(dedupe.admit("blog", "2.2.2.2", "/", "v2", 0));
        assert!(dedupe.admit("blog", "3.3.3.3", "/", "v3", 0));
        assert!(!dedupe.admit("blog", "1.1.1.1", "/", "x", 0));
        assert!(dedupe.admit("blog", "4.4.4.4", "/", "v4", 0));
        assert!(dedupe.size() <= 4);
        assert!(dedupe.admit("blog", "2.2.2.2", "/", "x", 0));
    }
}
