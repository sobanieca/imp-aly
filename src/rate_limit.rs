use crate::ip::{
    Ip, Network, format_ip, in_network, parse_client_address, parse_ip, parse_network,
};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub name: String,
    pub ms: u64,
    pub limit: u64,
}

pub fn default_limits() -> Vec<Window> {
    [
        ("5s", 5_000, 200),
        ("1m", 60_000, 1_500),
        ("1h", 3_600_000, 30_000),
        ("24h", 86_400_000, 200_000),
    ]
    .into_iter()
    .map(|(name, ms, limit)| Window {
        name: name.to_string(),
        ms,
        limit,
    })
    .collect()
}

pub const DEFAULT_MAX_CLIENTS: usize = 400_000;

pub const NETWORK_SCALE: u64 = 16;

pub const DEFAULT_TRUSTED_PROXIES: [&str; 2] = ["127.0.0.0/8", "::1"];

const PERIOD: usize = 0;
const CURRENT: usize = 1;
const PREVIOUS: usize = 2;
const FIELDS: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientKey {
    pub key: String,
    pub scale: u64,
}

struct Generation {
    slots: HashMap<String, usize>,
    counts: Vec<u32>,
}

impl Generation {
    fn new() -> Self {
        Generation {
            slots: HashMap::new(),
            counts: Vec::new(),
        }
    }
}

pub struct RateLimiter {
    limits: Vec<Window>,
    generation: usize,
    width: usize,
    recent: Generation,
    older: Generation,
}

impl RateLimiter {
    pub fn new(limits: Vec<Window>, max_clients: usize) -> Self {
        let width = limits.len() * FIELDS;
        RateLimiter {
            generation: max_clients.div_ceil(2).max(1),
            width,
            limits,
            recent: Generation::new(),
            older: Generation::new(),
        }
    }

    fn insert(&mut self, key: &str) -> usize {
        if self.recent.slots.len() >= self.generation {
            self.older = std::mem::replace(&mut self.recent, Generation::new());
        }
        let slot = self.recent.slots.len();
        self.recent.slots.insert(key.to_string(), slot);
        self.recent
            .counts
            .resize(self.recent.counts.len() + self.width, 0);
        slot * self.width
    }

    fn find(&mut self, key: &str) -> Option<usize> {
        if let Some(slot) = self.recent.slots.get(key) {
            return Some(slot * self.width);
        }
        let old = self.older.slots.remove(key)?;
        let copied = self.older.counts[old * self.width..(old + 1) * self.width].to_vec();
        let base = self.insert(key);
        self.recent.counts[base..base + self.width].copy_from_slice(&copied);
        Some(base)
    }

    fn update(&mut self, base: usize, at: u64) {
        for (position, limit) in self.limits.iter().enumerate() {
            let offset = base + position * FIELDS;
            let period = (at / limit.ms) as u32;
            let counts = &mut self.recent.counts;
            let last = counts[offset + PERIOD];
            if last == period {
                continue;
            }
            counts[offset + PREVIOUS] = if period.wrapping_sub(last) == 1 {
                counts[offset + CURRENT]
            } else {
                0
            };
            counts[offset + CURRENT] = 0;
            counts[offset + PERIOD] = period;
        }
    }

    pub fn take(&mut self, clients: &[ClientKey], amount: u64, at: u64) -> Option<Window> {
        for client in clients {
            let Some(base) = self.find(&client.key) else {
                continue;
            };
            self.update(base, at);
            for (position, limit) in self.limits.iter().enumerate() {
                let offset = base + position * FIELDS;
                let counts = &self.recent.counts;
                let weight = (limit.ms - at % limit.ms) as f64 / limit.ms as f64;
                let estimate = f64::from(counts[offset + PREVIOUS]) * weight
                    + f64::from(counts[offset + CURRENT]);
                if estimate + amount as f64 > (limit.limit * client.scale) as f64 {
                    return Some(limit.clone());
                }
            }
        }
        for client in clients {
            let base = match self.find(&client.key) {
                Some(base) => base,
                None => self.insert(&client.key),
            };
            self.update(base, at);
            for position in 0..self.limits.len() {
                let cell = &mut self.recent.counts[base + position * FIELDS + CURRENT];
                *cell = cell.saturating_add(amount.min(u64::from(u32::MAX)) as u32);
            }
        }
        None
    }

    pub fn size(&self) -> usize {
        self.recent.slots.len() + self.older.slots.len()
    }
}

pub fn max_batch(limits: &[Window]) -> u64 {
    limits.iter().map(|limit| limit.limit).min().unwrap_or(0)
}

pub fn client_keys(address: &str) -> Vec<ClientKey> {
    match parse_client_address(address) {
        None => vec![ClientKey {
            key: address.to_string(),
            scale: 1,
        }],
        Some(Ip::V4(parts)) => vec![ClientKey {
            key: format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], parts[3]),
            scale: 1,
        }],
        Some(Ip::V6(parts)) => {
            let network = format!("{:x}:{:x}:{:x}", parts[0], parts[1], parts[2]);
            vec![
                ClientKey {
                    key: format!("{network}:{:x}::/64", parts[3]),
                    scale: 1,
                },
                ClientKey {
                    key: format!("{network}::/48"),
                    scale: NETWORK_SCALE,
                },
            ]
        }
    }
}

pub fn parse_trusted_proxies(list: &[String]) -> Result<Vec<Network>, String> {
    list.iter().map(|entry| parse_network(entry)).collect()
}

pub fn is_trusted(remote: &str, trusted: &[Network]) -> bool {
    let ip = parse_ip(remote);
    trusted
        .iter()
        .any(|network| in_network(ip.as_ref(), network))
}

pub fn client_address(
    remote: &str,
    header: Option<&str>,
    ip_header: Option<&str>,
    trusted: &[Network],
) -> String {
    if ip_header.is_none() || !is_trusted(remote, trusted) {
        return remote.to_string();
    }
    let Some(value) = header.filter(|value| !value.is_empty()) else {
        return remote.to_string();
    };
    let last = value
        .split(',')
        .map(str::trim)
        .rfind(|entry| !entry.is_empty());
    match last.and_then(parse_client_address) {
        Some(ip) => format_ip(&ip),
        None => remote.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows(list: &[(&str, u64, u64)]) -> Vec<Window> {
        list.iter()
            .map(|(name, ms, limit)| Window {
                name: name.to_string(),
                ms: *ms,
                limit: *limit,
            })
            .collect()
    }

    fn one(key: &str) -> Vec<ClientKey> {
        vec![ClientKey {
            key: key.to_string(),
            scale: 1,
        }]
    }

    #[test]
    fn blocks_an_address_over_a_window_and_frees_it_later() {
        let mut limiter = RateLimiter::new(windows(&[("5s", 5_000, 3)]), 100);
        let start = 1_000_000_000;
        for _ in 0..3 {
            assert!(limiter.take(&one("a"), 1, start).is_none());
        }
        assert_eq!(limiter.take(&one("a"), 1, start).unwrap().name, "5s");
        assert!(limiter.take(&one("b"), 1, start).is_none());
        assert!(limiter.take(&one("a"), 1, start + 10_000).is_none());
    }

    #[test]
    fn the_previous_window_counts_with_its_weight() {
        let mut limiter = RateLimiter::new(windows(&[("10s", 10_000, 10)]), 100);
        let start = 1_000_000_000;
        assert!(limiter.take(&one("a"), 10, start).is_none());
        assert!(limiter.take(&one("a"), 1, start + 10_000).is_some());
        assert!(limiter.take(&one("a"), 5, start + 15_000).is_none());
    }

    #[test]
    fn a_refused_amount_is_not_counted() {
        let mut limiter = RateLimiter::new(windows(&[("5s", 5_000, 5)]), 100);
        let start = 1_000_000_000;
        assert!(limiter.take(&one("a"), 4, start).is_none());
        assert!(limiter.take(&one("a"), 3, start).is_some());
        assert!(limiter.take(&one("a"), 1, start).is_none());
    }

    #[test]
    fn keeps_two_generations_of_addresses_and_forgets_the_older_one() {
        let mut limiter = RateLimiter::new(windows(&[("1h", 3_600_000, 1)]), 4);
        let at = 1_000_000_000;
        assert!(limiter.take(&one("a"), 1, at).is_none());
        assert!(limiter.take(&one("b"), 1, at).is_none());
        assert!(limiter.take(&one("c"), 1, at).is_none());
        assert!(limiter.take(&one("a"), 1, at).is_some());
        assert!(limiter.take(&one("d"), 1, at).is_none());
        assert!(limiter.take(&one("e"), 1, at).is_none());
        assert!(limiter.size() <= 4);
        assert!(limiter.take(&one("b"), 1, at).is_none());
    }

    #[test]
    fn the_addresses_of_one_ipv6_48_share_a_larger_limit() {
        let mut limiter = RateLimiter::new(windows(&[("5s", 5_000, 2)]), 100);
        let at = 1_000_000_000;
        for host in 0..32 {
            let keys = client_keys(&format!("2001:db8:1:{host:x}::1"));
            assert!(limiter.take(&keys, 1, at).is_none(), "{host}");
        }
        assert!(
            limiter
                .take(&client_keys("2001:db8:1:99::1"), 1, at)
                .is_some()
        );
    }

    #[test]
    fn makes_the_keys_of_a_client_address() {
        assert_eq!(client_keys("203.0.113.9"), one("203.0.113.9"));
        assert_eq!(client_keys("::ffff:203.0.113.9"), one("203.0.113.9"));
        let keys = client_keys("2001:db8:1:2:3:4:5:6");
        assert_eq!(keys[0].key, "2001:db8:1:2::/64");
        assert_eq!(keys[1].key, "2001:db8:1::/48");
        assert_eq!(keys[1].scale, NETWORK_SCALE);
        assert_eq!(client_keys("unknown"), one("unknown"));
    }

    #[test]
    fn reads_the_client_address_from_the_header_of_a_trusted_proxy_only() {
        let trusted =
            parse_trusted_proxies(&["127.0.0.0/8".to_string(), "::1".to_string()]).unwrap();
        let header = Some("198.51.100.1, 203.0.113.9");
        let name = Some("x-forwarded-for");
        assert_eq!(
            client_address("127.0.0.1", header, name, &trusted),
            "203.0.113.9"
        );
        assert_eq!(
            client_address("10.0.0.1", header, name, &trusted),
            "10.0.0.1"
        );
        assert_eq!(
            client_address("127.0.0.1", header, None, &trusted),
            "127.0.0.1"
        );
        assert_eq!(
            client_address("127.0.0.1", None, name, &trusted),
            "127.0.0.1"
        );
        assert_eq!(
            client_address("::1", Some("[2001:db8::1]:443"), name, &trusted),
            "2001:db8:0:0:0:0:0:1"
        );
        assert_eq!(
            client_address("127.0.0.1", Some("garbage"), name, &trusted),
            "127.0.0.1"
        );
    }
}
