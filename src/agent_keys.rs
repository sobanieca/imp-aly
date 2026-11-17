use crate::auth::generate_key;
use crate::days::{iso, parse_iso};
use crate::error::{Error, Result};
use crate::fsutil::{read_json, write_private_json_atomic};
use crate::json::{Object, Value};
use crate::names::is_app_name;
use crate::paths::join;
use crate::token::{AgentSigner, TokenVerifier};
use std::sync::{Arc, Mutex, MutexGuard};

pub const AGENT_KEYS_FILE: &str = "agent-keys.json";

pub const MAX_AGENT_KEYS: usize = 20;

pub const AGENT_KEY_HOURS: [i64; 4] = [1, 4, 8, 24];

const HOUR_MS: i64 = 3_600_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKey {
    pub name: String,
    pub key: String,
    pub created_at: i64,
    pub expires_at: i64,
}

impl AgentKey {
    fn stored(&self) -> Value {
        Object::new()
            .with("name", self.name.clone())
            .with("key", self.key.clone())
            .with("createdAt", iso(self.created_at))
            .with("expiresAt", iso(self.expires_at))
            .into()
    }

    fn described(&self) -> Object {
        Object::new()
            .with("name", self.name.clone())
            .with("createdAt", iso(self.created_at))
            .with("expiresAt", iso(self.expires_at))
    }
}

fn is_key_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn read_entry(value: &Value) -> Option<AgentKey> {
    let name = value.get_str("name")?;
    let key = value.get_str("key")?;
    if !is_app_name(name) || !is_key_text(key) {
        return None;
    }
    Some(AgentKey {
        name: name.to_string(),
        key: key.to_string(),
        created_at: parse_iso(value.get_str("createdAt")?)?,
        expires_at: parse_iso(value.get_str("expiresAt")?)?,
    })
}

fn bad_request(message: impl Into<String>) -> Error {
    Error::status(400, message)
}

pub fn hours_text() -> String {
    AGENT_KEY_HOURS
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn expiry_of(body: &Value, now: i64) -> Result<i64> {
    let hours = body
        .get("hours")
        .and_then(Value::as_safe_integer)
        .filter(|hours| AGENT_KEY_HOURS.contains(hours))
        .ok_or_else(|| bad_request(format!("\"hours\" must be one of {}", hours_text())))?;
    Ok(now + hours * HOUR_MS)
}

pub struct AgentKeys {
    path: String,
    keys: Mutex<Vec<AgentKey>>,
    verifier: Arc<Mutex<TokenVerifier>>,
}

impl AgentKeys {
    pub fn open(data_dir: &str, verifier: Arc<Mutex<TokenVerifier>>, now: i64) -> Result<Self> {
        let path = join(&[data_dir, AGENT_KEYS_FILE]);
        let stored = read_json(&path)?;
        let mut keys: Vec<AgentKey> = Vec::new();
        if let Some(entries) = stored
            .as_ref()
            .and_then(|value| value.get("keys"))
            .and_then(Value::as_array)
        {
            for entry in entries.iter().filter_map(read_entry) {
                if entry.expires_at > now && !keys.iter().any(|key| key.name == entry.name) {
                    keys.push(entry);
                }
            }
        }
        keys.truncate(MAX_AGENT_KEYS);
        let registry = AgentKeys {
            path,
            keys: Mutex::new(keys),
            verifier,
        };
        registry.apply(&registry.lock());
        Ok(registry)
    }

    fn lock(&self) -> MutexGuard<'_, Vec<AgentKey>> {
        self.keys
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn apply(&self, keys: &[AgentKey]) {
        let signers = keys
            .iter()
            .map(|entry| AgentSigner::new(&entry.name, &entry.key, entry.expires_at))
            .collect();
        self.verifier
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .set_agents(signers);
    }

    fn save(&self, keys: &[AgentKey]) -> Result<()> {
        let entries: Vec<Value> = keys.iter().map(AgentKey::stored).collect();
        write_private_json_atomic(&self.path, &Object::new().with("keys", entries).into())
    }

    fn change(&self, now: i64, edit: impl FnOnce(&mut Vec<AgentKey>) -> Result<()>) -> Result<()> {
        let mut keys = self.lock();
        let mut next: Vec<AgentKey> = keys
            .iter()
            .filter(|entry| entry.expires_at > now)
            .cloned()
            .collect();
        edit(&mut next)?;
        if next != *keys {
            self.save(&next)?;
            *keys = next;
            self.apply(&keys);
        }
        Ok(())
    }

    pub fn list(&self, now: i64) -> Value {
        let keys: Vec<Value> = self
            .lock()
            .iter()
            .filter(|entry| entry.expires_at > now)
            .map(|entry| entry.described().into())
            .collect();
        Object::new().with("keys", keys).into()
    }

    pub fn add(&self, body: &Value, now: i64) -> Result<Value> {
        let name = body
            .get_str("name")
            .ok_or_else(|| bad_request("send the \"name\" of the agent key"))?
            .to_string();
        if !is_app_name(&name) {
            return Err(bad_request(format!(
                "\"{name}\" is not a key name - use up to 63 lowercase letters, digits and \"-\", and start with a letter or a digit"
            )));
        }
        let expires_at = expiry_of(body, now)?;
        let created = AgentKey {
            name: name.clone(),
            key: generate_key(),
            created_at: now,
            expires_at,
        };
        let entry = created.clone();
        self.change(now, move |keys| {
            if keys.iter().any(|key| key.name == name) {
                return Err(Error::status(
                    409,
                    format!("an agent key with the name \"{name}\" exists - remove it first"),
                ));
            }
            if keys.len() >= MAX_AGENT_KEYS {
                return Err(Error::status(
                    409,
                    format!("the server keeps at most {MAX_AGENT_KEYS} agent keys"),
                ));
            }
            keys.push(entry);
            Ok(())
        })?;
        Ok(created.described().with("key", created.key.clone()).into())
    }

    pub fn remove(&self, name: &str, now: i64) -> Result<()> {
        self.change(now, |keys| {
            let before = keys.len();
            keys.retain(|key| key.name != name);
            if keys.len() == before {
                return Err(Error::status(
                    404,
                    format!("no agent key \"{name}\" - it expired, or it was never added"),
                ));
            }
            Ok(())
        })
    }

    pub fn clear(&self) -> Result<()> {
        let mut keys = self.lock();
        self.save(&[])?;
        keys.clear();
        self.apply(&keys);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use crate::testing::TempDir;
    use crate::token::{EMPTY_BODY_HASH, create_token_at};
    use std::os::unix::fs::PermissionsExt;

    const NOW: i64 = 1_790_000_000_000;

    fn body(text: &str) -> Value {
        json::parse(text).unwrap()
    }

    fn open(dir: &TempDir) -> (AgentKeys, Arc<Mutex<TokenVerifier>>) {
        let verifier = Arc::new(Mutex::new(TokenVerifier::new("main-key-0123456789")));
        let keys = AgentKeys::open(&dir.path, verifier.clone(), NOW).unwrap();
        (keys, verifier)
    }

    fn passes(
        verifier: &Arc<Mutex<TokenVerifier>>,
        key: &str,
        now: i64,
    ) -> std::result::Result<String, String> {
        let token = create_token_at(key, "GET", "/status", EMPTY_BODY_HASH, now);
        verifier
            .lock()
            .unwrap()
            .verify_at(&token, "GET", "/status", now)
            .map(|verified| verified.agent.unwrap_or_default())
    }

    #[test]
    fn the_expiry_takes_one_of_the_fixed_hours() {
        for hours in AGENT_KEY_HOURS {
            let value = body(&format!(r#"{{"hours":{hours}}}"#));
            assert_eq!(expiry_of(&value, NOW).unwrap(), NOW + hours * HOUR_MS);
        }
        for wrong in [
            r#"{"hours":0}"#,
            r#"{"hours":2}"#,
            r#"{"hours":48}"#,
            r#"{"hours":1.5}"#,
            r#"{"hours":"4"}"#,
            r#"{"minutes":60}"#,
            r#"{}"#,
        ] {
            assert_eq!(expiry_of(&body(wrong), NOW).unwrap_err().status, Some(400));
        }
    }

    #[test]
    fn an_agent_key_signs_tokens_until_it_expires_or_is_removed() {
        let dir = TempDir::new();
        let (keys, verifier) = open(&dir);
        let added = keys
            .add(&body(r#"{"name":"claude","hours":1}"#), NOW)
            .unwrap();
        let key = added.get_str("key").unwrap().to_string();
        assert_eq!(key.len(), 32);
        assert_eq!(added.get_str("expiresAt").unwrap(), iso(NOW + HOUR_MS));
        assert_eq!(passes(&verifier, &key, NOW + 1000).unwrap(), "claude");
        assert!(
            passes(&verifier, &key, NOW + HOUR_MS)
                .unwrap_err()
                .contains("expired")
        );
        let listed = keys.list(NOW);
        let entries = listed.get("keys").and_then(Value::as_array).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].get("key").is_none());
        assert_eq!(
            keys.add(&body(r#"{"name":"claude","hours":1}"#), NOW)
                .unwrap_err()
                .status,
            Some(409)
        );
        keys.remove("claude", NOW).unwrap();
        assert!(passes(&verifier, &key, NOW + 1000).is_err());
        assert_eq!(keys.remove("claude", NOW).unwrap_err().status, Some(404));
    }

    #[test]
    fn the_keys_stay_after_a_restart_in_a_private_file() {
        let dir = TempDir::new();
        let (keys, _) = open(&dir);
        let added = keys
            .add(&body(r#"{"name":"agent-1","hours":4}"#), NOW)
            .unwrap();
        keys.add(&body(r#"{"name":"agent-2","hours":1}"#), NOW)
            .unwrap();
        let path = dir.join(AGENT_KEYS_FILE);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let verifier = Arc::new(Mutex::new(TokenVerifier::new("main-key-0123456789")));
        let later = NOW + 2 * HOUR_MS;
        let again = AgentKeys::open(&dir.path, verifier.clone(), later).unwrap();
        let listed = again.list(later);
        let entries = listed.get("keys").and_then(Value::as_array).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].get_str("name"), Some("agent-1"));
        let key = added.get_str("key").unwrap();
        assert_eq!(passes(&verifier, key, later).unwrap(), "agent-1");
        again.clear().unwrap();
        assert!(passes(&verifier, key, later).is_err());
    }

    #[test]
    fn a_server_keeps_a_limited_count_of_keys_with_valid_names() {
        let dir = TempDir::new();
        let (keys, _) = open(&dir);
        for index in 0..MAX_AGENT_KEYS {
            keys.add(&body(&format!(r#"{{"name":"a{index}","hours":1}}"#)), NOW)
                .unwrap();
        }
        assert_eq!(
            keys.add(&body(r#"{"name":"one-more","hours":1}"#), NOW)
                .unwrap_err()
                .status,
            Some(409)
        );
        assert_eq!(
            keys.add(&body(r#"{"name":"Bad Name","hours":1}"#), NOW)
                .unwrap_err()
                .status,
            Some(400)
        );
        let later = NOW + HOUR_MS;
        keys.add(&body(r#"{"name":"one-more","hours":1}"#), later)
            .unwrap();
    }
}
