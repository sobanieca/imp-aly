use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    pub scheme: String,
    pub username: String,
    pub password: String,
    pub host: String,
    pub port: Option<u16>,
    pub path: String,
    pub query: Option<String>,
    pub fragment: Option<String>,
}

const FORBIDDEN_HOST: &[u8] = b" #%/:<>?@[\\]^|";

fn default_port(scheme: &str) -> u16 {
    if scheme == "https" { 443 } else { 80 }
}

fn encode_into(out: &mut String, text: &str, extra: &[u8]) {
    for byte in text.bytes() {
        if !(0x21..0x7f).contains(&byte) || extra.contains(&byte) {
            let _ = write!(out, "%{byte:02X}");
        } else {
            out.push(byte as char);
        }
    }
}

const PATH_SET: &[u8] = b"\"#<>?`{}";

const QUERY_SET: &[u8] = b"\"#<>'";

pub fn normalize_path(raw: &str) -> String {
    let mut encoded = String::new();
    encode_into(&mut encoded, &raw.replace('\\', "/"), PATH_SET);
    let mut segments: Vec<&str> = Vec::new();
    let parts: Vec<&str> = encoded.split('/').skip(1).collect();
    let last = parts.len().saturating_sub(1);
    for (at, segment) in parts.iter().enumerate() {
        let lower = segment.to_ascii_lowercase();
        let single = lower == "." || lower == "%2e";
        let double = matches!(lower.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e");
        if double {
            segments.pop();
            if at == last {
                segments.push("");
            }
        } else if single {
            if at == last {
                segments.push("");
            }
        } else {
            segments.push(segment);
        }
    }
    format!("/{}", segments.join("/"))
}

pub fn normalize_query(raw: &str) -> String {
    let mut out = String::new();
    encode_into(&mut out, raw, QUERY_SET);
    out
}

pub fn request_target(raw: &str) -> String {
    let without_fragment = raw.split('#').next().unwrap_or("");
    let (path, query) = match without_fragment.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (without_fragment, None),
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let mut target = normalize_path(&path);
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        target.push('?');
        target.push_str(&normalize_query(query));
    }
    target
}

fn parse_host(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if let Some(inner) = text.strip_prefix('[') {
        let inner = inner.strip_suffix(']')?;
        let address: std::net::Ipv6Addr = inner.parse().ok()?;
        return Some(format!("[{address}]"));
    }
    let lower = text.to_ascii_lowercase();
    if lower
        .bytes()
        .any(|byte| byte < 0x21 || byte == 0x7f || FORBIDDEN_HOST.contains(&byte))
    {
        return None;
    }
    Some(lower)
}

impl Url {
    pub fn parse(input: &str) -> Option<Url> {
        let text = input.trim_matches(|c: char| c <= ' ');
        let colon = text.find(':')?;
        let scheme = text[..colon].to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let rest = text[colon + 1..].trim_start_matches(['/', '\\']);
        let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..end];
        let after = &rest[end..];
        let (userinfo, hostport) = match authority.rfind('@') {
            Some(at) => (&authority[..at], &authority[at + 1..]),
            None => ("", authority),
        };
        let (username, password) = match userinfo.split_once(':') {
            Some((user, pass)) => (user.to_string(), pass.to_string()),
            None => (userinfo.to_string(), String::new()),
        };
        let (host_text, port_text) = if hostport.starts_with('[') {
            let close = hostport.find(']')?;
            let port = hostport[close + 1..].strip_prefix(':');
            if close + 1 < hostport.len() && port.is_none() {
                return None;
            }
            (&hostport[..=close], port)
        } else {
            match hostport.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (hostport, None),
            }
        };
        let host = parse_host(host_text)?;
        let port = match port_text {
            None | Some("") => None,
            Some(digits) => {
                if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                let value: u32 = digits.parse().ok()?;
                if value > 65535 {
                    return None;
                }
                let value = value as u16;
                if value == default_port(&scheme) {
                    None
                } else {
                    Some(value)
                }
            }
        };
        let (before_fragment, fragment) = match after.split_once('#') {
            Some((before, fragment)) => (before, Some(fragment.to_string())),
            None => (after, None),
        };
        let (raw_path, query) = match before_fragment.split_once('?') {
            Some((path, query)) => (path, Some(normalize_query(query))),
            None => (before_fragment, None),
        };
        let path = if raw_path.is_empty() {
            "/".to_string()
        } else {
            normalize_path(raw_path)
        };
        Some(Url {
            scheme,
            username,
            password,
            host,
            port,
            path,
            query,
            fragment,
        })
    }

    pub fn origin(&self) -> String {
        match self.port {
            Some(port) => format!("{}://{}:{port}", self.scheme, self.host),
            None => format!("{}://{}", self.scheme, self.host),
        }
    }

    pub fn href(&self) -> String {
        let mut out = format!("{}://", self.scheme);
        if !self.username.is_empty() || !self.password.is_empty() {
            out.push_str(&self.username);
            if !self.password.is_empty() {
                out.push(':');
                out.push_str(&self.password);
            }
            out.push('@');
        }
        out.push_str(&self.host);
        if let Some(port) = self.port {
            let _ = write!(out, ":{port}");
        }
        out.push_str(&self.path);
        if let Some(query) = &self.query {
            out.push('?');
            out.push_str(query);
        }
        if let Some(fragment) = &self.fragment {
            out.push('#');
            out.push_str(fragment);
        }
        out
    }

    pub fn has_search(&self) -> bool {
        self.query.as_deref().is_some_and(|query| !query.is_empty())
    }

    pub fn has_hash(&self) -> bool {
        self.fragment
            .as_deref()
            .is_some_and(|fragment| !fragment.is_empty())
    }

    pub fn has_user(&self) -> bool {
        !self.username.is_empty() || !self.password.is_empty()
    }

    pub fn join(&self, relative: &str) -> Url {
        let base = match self.path.rfind('/') {
            Some(at) => &self.path[..=at],
            None => "/",
        };
        Url {
            path: normalize_path(&format!("{base}{relative}")),
            query: None,
            fragment: None,
            ..self.clone()
        }
    }
}

pub fn decode_component(text: &str, plus_as_space: bool) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte == b'%'
            && let Some(value) = text
                .get(at + 1..at + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(value);
            at += 3;
            continue;
        }
        out.push(if plus_as_space && byte == b'+' {
            b' '
        } else {
            byte
        });
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn strict_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn search_params(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (decode_component(key, true), decode_component(value, true)),
            None => (decode_component(pair, true), String::new()),
        })
        .collect()
}

pub fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

pub fn encode_form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| {
            let encode = |text: &str| {
                let mut out = String::new();
                for byte in text.bytes() {
                    if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) {
                        out.push(byte as char);
                    } else if byte == b' ' {
                        out.push('+');
                    } else {
                        let _ = write!(out, "%{byte:02X}");
                    }
                }
                out
            };
            format!("{}={}", encode(key), encode(value))
        })
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_urls_like_the_platform() {
        let url = Url::parse("HTTPS://MyApp.Example:443/a/../b?x=1#top").unwrap();
        assert_eq!(url.href(), "https://myapp.example/b?x=1#top");
        assert_eq!(url.origin(), "https://myapp.example");
        let url = Url::parse("http://[::1]:4410").unwrap();
        assert_eq!(url.href(), "http://[::1]:4410/");
        assert!(Url::parse("ftp://a.example").is_none());
        assert!(Url::parse("myapp.example").is_none());
        assert!(Url::parse("http://a b.example").is_none());
        assert!(Url::parse("http://a.example:99999").is_none());
        let base = Url::parse("https://myapp.example/app/").unwrap();
        assert_eq!(
            base.join("app-analytics.json").href(),
            "https://myapp.example/app/app-analytics.json"
        );
    }

    #[test]
    fn a_request_target_is_normalized() {
        assert_eq!(request_target("/a/./b/../c?x=1 2"), "/a/c?x=1%202");
        assert_eq!(
            request_target("/backup?last=all&by=day"),
            "/backup?last=all&by=day"
        );
        assert_eq!(request_target("/apps/a b"), "/apps/a%20b");
        assert_eq!(request_target("/status?"), "/status");
    }

    #[test]
    fn decodes_search_params() {
        assert_eq!(
            search_params("last=all&by=day&x=a+b%21"),
            vec![
                ("last".to_string(), "all".to_string()),
                ("by".to_string(), "day".to_string()),
                ("x".to_string(), "a b!".to_string()),
            ]
        );
        assert_eq!(
            encode_form(&[("last", "all"), ("by", "day")]),
            "last=all&by=day"
        );
    }
}
