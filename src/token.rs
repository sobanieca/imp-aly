use crate::days::now_ms;
use crate::url::request_target;
use ring::digest;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;

pub const TOKEN_TTL_MS: i64 = 60_000;

const NONCE_BYTES: usize = 12;

pub const EMPTY_BODY_HASH: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, bytes).as_ref())
}

pub struct Sha256(digest::Context);

impl Default for Sha256 {
    fn default() -> Self {
        Sha256(digest::Context::new(&digest::SHA256))
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn hex(self) -> String {
        hex(self.0.finish().as_ref())
    }
}

pub fn random_bytes(count: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; count];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system has no random source");
    bytes
}

pub fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn signed_text(
    timestamp: &str,
    nonce: &str,
    method: &str,
    target: &str,
    body_hash: &str,
) -> String {
    [
        timestamp,
        nonce,
        &method.to_ascii_uppercase(),
        target,
        body_hash,
    ]
    .join("\n")
}

fn sign(key: &hmac::Key, text: &str) -> String {
    hex(hmac::sign(key, text.as_bytes()).as_ref())
}

fn signing_key(key: &str) -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes())
}

pub fn create_token(key: &str, method: &str, path: &str, body_hash: &str) -> String {
    create_token_at(key, method, path, body_hash, now_ms())
}

pub fn create_token_at(key: &str, method: &str, path: &str, body_hash: &str, at: i64) -> String {
    let timestamp = at.to_string();
    let nonce = hex(&random_bytes(NONCE_BYTES));
    let mac = sign(
        &signing_key(key),
        &signed_text(&timestamp, &nonce, method, &request_target(path), body_hash),
    );
    format!("{timestamp}.{nonce}.{body_hash}.{mac}")
}

pub fn safe_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut difference = a.len() ^ b.len();
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        difference |= usize::from(left ^ right);
    }
    std::hint::black_box(difference) == 0
}

pub struct TokenVerifier {
    key: hmac::Key,
    ttl_ms: i64,
    used: HashMap<String, i64>,
    next_prune: i64,
}

#[derive(Debug)]
pub struct Verified {
    pub body_hash: String,
}

fn parse_timestamp(text: &str) -> Option<i64> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: i64 = text.parse().ok()?;
    (value.abs() <= 9_007_199_254_740_991).then_some(value)
}

impl TokenVerifier {
    pub fn new(key: &str) -> Self {
        Self::with_ttl(key, TOKEN_TTL_MS)
    }

    pub fn with_ttl(key: &str, ttl_ms: i64) -> Self {
        TokenVerifier {
            key: signing_key(key),
            ttl_ms,
            used: HashMap::new(),
            next_prune: 0,
        }
    }

    pub fn verify(&mut self, token: &str, method: &str, target: &str) -> Result<Verified, String> {
        self.verify_at(token, method, target, now_ms())
    }

    pub fn verify_at(
        &mut self,
        token: &str,
        method: &str,
        target: &str,
        now: i64,
    ) -> Result<Verified, String> {
        let parts: Vec<&str> = token.split('.').collect();
        let malformed = || "malformed token".to_string();
        if parts.len() != 4 {
            return Err(malformed());
        }
        let (timestamp, nonce, body_hash, mac) = (parts[0], parts[1], parts[2], parts[3]);
        let time = parse_timestamp(timestamp).ok_or_else(malformed)?;
        if nonce.is_empty() || mac.is_empty() || !is_hash(body_hash) || nonce.len() > 128 {
            return Err(malformed());
        }
        if now >= self.next_prune {
            self.used.retain(|_, expires| *expires > now);
            self.next_prune = now + 1000;
        }
        if (now - time).abs() > self.ttl_ms {
            return Err("token expired (check the clock on both machines)".to_string());
        }
        let expected = sign(
            &self.key,
            &signed_text(timestamp, nonce, method, target, body_hash),
        );
        if !safe_equal(mac, &expected) {
            return Err("wrong key, or a token for another request".to_string());
        }
        if self.used.get(nonce).is_some_and(|expires| *expires > now) {
            return Err("token already used".to_string());
        }
        self.used.insert(nonce.to_string(), now + 2 * self.ttl_ms);
        Ok(Verified {
            body_hash: body_hash.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_the_platform() {
        assert_eq!(sha256_hex(b""), EMPTY_BODY_HASH);
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let mut hash = Sha256::new();
        hash.update(b"a");
        hash.update(b"bc");
        assert_eq!(hash.hex(), sha256_hex(b"abc"));
    }

    #[test]
    fn a_token_works_once() {
        let mut verifier = TokenVerifier::new("key-0123456789");
        let token = create_token("key-0123456789", "get", "/status", EMPTY_BODY_HASH);
        assert!(verifier.verify(&token, "GET", "/status").is_ok());
        assert_eq!(
            verifier.verify(&token, "GET", "/status").err().unwrap(),
            "token already used"
        );
    }

    #[test]
    fn a_token_signed_with_another_key_or_too_old_fails() {
        let mut verifier = TokenVerifier::new("key-0123456789");
        let other = create_token("other-0123456789", "GET", "/status", EMPTY_BODY_HASH);
        assert!(
            verifier
                .verify(&other, "GET", "/status")
                .unwrap_err()
                .contains("wrong key")
        );
        let old = create_token_at(
            "key-0123456789",
            "GET",
            "/status",
            EMPTY_BODY_HASH,
            now_ms() - 120_000,
        );
        assert!(
            verifier
                .verify(&old, "GET", "/status")
                .unwrap_err()
                .contains("expired")
        );
        let token = create_token("key-0123456789", "GET", "/status", EMPTY_BODY_HASH);
        assert!(
            verifier
                .verify(&token, "GET", "/apps")
                .unwrap_err()
                .contains("another request")
        );
        assert_eq!(
            verifier.verify("a.b.c", "GET", "/").unwrap_err(),
            "malformed token"
        );
    }

    #[test]
    fn a_token_of_the_javascript_console_passes() {
        let token = "1791729377179.0ef985e9087e74ec3ba6e321.ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.4937cd32dff44484302b1926b462d312b83dcc19d1985b73e467614249046261";
        let mut verifier = TokenVerifier::new("test-key-0123456789");
        let target = request_target("/apps/my app?x=1 2");
        assert_eq!(target, "/apps/my%20app?x=1%202");
        let verified = verifier
            .verify_at(token, "POST", &target, 1_791_729_377_500)
            .unwrap();
        assert_eq!(verified.body_hash, sha256_hex(b"abc"));
        let mine = create_token_at(
            "test-key-0123456789",
            "post",
            "/apps/my app?x=1 2",
            &sha256_hex(b"abc"),
            1_791_729_377_179,
        );
        let mut fresh = TokenVerifier::new("test-key-0123456789");
        assert!(
            fresh
                .verify_at(&mine, "POST", &target, 1_791_729_377_500)
                .is_ok()
        );
    }
}
