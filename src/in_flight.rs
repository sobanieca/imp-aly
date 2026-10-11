use crate::rate_limit::ClientKey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const CLIENT_SHARE: usize = 32;

pub const NETWORK_SHARE: usize = 4;

struct State {
    count: usize,
    by_key: HashMap<String, usize>,
}

pub struct InFlight {
    max: usize,
    per_client: usize,
    state: Arc<Mutex<State>>,
}

pub struct Ticket {
    keys: Vec<String>,
    state: Arc<Mutex<State>>,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.count = state.count.saturating_sub(1);
        for key in &self.keys {
            let left = state.by_key.get(key).copied().unwrap_or(1) - 1;
            if left > 0 {
                state.by_key.insert(key.clone(), left);
            } else {
                state.by_key.remove(key);
            }
        }
    }
}

impl InFlight {
    pub fn new(max: usize, per_client: Option<usize>) -> Self {
        InFlight {
            max,
            per_client: per_client.unwrap_or_else(|| (max / CLIENT_SHARE).max(1)),
            state: Arc::new(Mutex::new(State {
                count: 0,
                by_key: HashMap::new(),
            })),
        }
    }

    fn limit_of(&self, client: &ClientKey) -> usize {
        if client.scale > 1 {
            self.per_client * NETWORK_SHARE
        } else {
            self.per_client
        }
    }

    pub fn count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .count
    }

    pub fn full(&self) -> bool {
        self.count() >= self.max
    }

    pub fn enter(&self, clients: &[ClientKey]) -> Option<Ticket> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if clients.iter().any(|client| {
            state.by_key.get(&client.key).copied().unwrap_or(0) >= self.limit_of(client)
        }) {
            return None;
        }
        state.count += 1;
        for client in clients {
            *state.by_key.entry(client.key.clone()).or_insert(0) += 1;
        }
        Some(Ticket {
            keys: clients.iter().map(|client| client.key.clone()).collect(),
            state: self.state.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rate_limit::client_keys;

    #[test]
    fn one_address_holds_only_its_share_of_the_requests_in_progress() {
        let in_flight = InFlight::new(64, None);
        let a = client_keys("203.0.113.1");
        let tickets: Vec<_> = (0..2).map(|_| in_flight.enter(&a).unwrap()).collect();
        assert!(in_flight.enter(&a).is_none());
        assert!(in_flight.enter(&client_keys("203.0.113.2")).is_some());
        drop(tickets);
        assert_eq!(in_flight.count(), 0);
        assert!(in_flight.enter(&a).is_some());
    }

    #[test]
    fn the_networks_of_a_48_share_a_few_times_the_share_of_one_address() {
        let in_flight = InFlight::new(64, None);
        let mut held = Vec::new();
        for host in 0..8 {
            held.push(
                in_flight
                    .enter(&client_keys(&format!("2001:db8:1:{host:x}::1")))
                    .unwrap(),
            );
        }
        assert!(in_flight.enter(&client_keys("2001:db8:1:99::1")).is_none());
        assert!(in_flight.enter(&client_keys("2001:db8:2::1")).is_some());
    }

    #[test]
    fn the_cap_of_all_requests_stays_the_first_check() {
        let in_flight = InFlight::new(2, Some(5));
        let first = in_flight.enter(&client_keys("203.0.113.1")).unwrap();
        let second = in_flight.enter(&client_keys("203.0.113.2")).unwrap();
        assert!(in_flight.full());
        drop(first);
        assert!(!in_flight.full());
        drop(second);
    }
}
