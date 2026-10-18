use crate::error::{Error, Result};
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Switch,
}

const FLAGS: [(&str, Kind); 35] = [
    ("port", Kind::Text),
    ("admin-port", Kind::Text),
    ("admin-bind", Kind::Text),
    ("data", Kind::Text),
    ("auth", Kind::Text),
    ("bind", Kind::Text),
    ("url", Kind::Text),
    ("server", Kind::Text),
    ("ip-header", Kind::Text),
    ("trusted-proxy", Kind::Text),
    ("max-requests", Kind::Text),
    ("max-connections", Kind::Text),
    ("country-header", Kind::Text),
    ("allow-origin", Kind::Text),
    ("min-free", Kind::Text),
    ("tls-cert", Kind::Text),
    ("tls-key", Kind::Text),
    ("segments", Kind::Text),
    ("last", Kind::Text),
    ("by", Kind::Text),
    ("timeout", Kind::Text),
    ("limit-5s", Kind::Text),
    ("limit-1m", Kind::Text),
    ("limit-1h", Kind::Text),
    ("limit-24h", Kind::Text),
    ("foreground", Kind::Switch),
    ("no-auto-update", Kind::Switch),
    ("check", Kind::Switch),
    ("auto", Kind::Switch),
    ("init", Kind::Switch),
    ("uninstall", Kind::Switch),
    ("json", Kind::Switch),
    ("help", Kind::Switch),
    ("version", Kind::Switch),
    ("debug", Kind::Switch),
];

const ALIASES: [(char, &str); 6] = [
    ('p', "port"),
    ('a', "auth"),
    ('d', "data"),
    ('s', "server"),
    ('h', "help"),
    ('v', "version"),
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub positional: Vec<String>,
    pub flags: BTreeMap<String, Option<String>>,
}

impl Parsed {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.flags.get(name).and_then(|value| value.as_deref())
    }

    pub fn has(&self, name: &str) -> bool {
        self.flags.contains_key(name)
    }
}

fn kind_of(name: &str) -> Option<Kind> {
    FLAGS
        .iter()
        .find(|(flag, _)| *flag == name)
        .map(|(_, kind)| *kind)
}

pub fn parse_args(argv: &[String]) -> Result<Parsed> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < argv.len() {
        let argument = &argv[index];
        index += 1;
        if argument == "--" {
            parsed.positional.extend(argv[index..].iter().cloned());
            break;
        }
        let (name, inline) = if let Some(rest) = argument.strip_prefix("--") {
            match rest.split_once('=') {
                Some((name, value)) => (name.to_string(), Some(value.to_string())),
                None => (rest.to_string(), None),
            }
        } else if argument.len() == 2
            && argument.starts_with('-')
            && argument.as_bytes()[1].is_ascii_alphabetic()
        {
            let letter = argument.chars().nth(1).unwrap_or('-');
            match ALIASES.iter().find(|(alias, _)| *alias == letter) {
                Some((_, name)) => (name.to_string(), None),
                None => {
                    return Err(Error::new(format!(
                        "unknown option {argument} - run imp-aly help"
                    )));
                }
            }
        } else {
            parsed.positional.push(argument.clone());
            continue;
        };
        let Some(kind) = kind_of(&name) else {
            return Err(Error::new(format!(
                "unknown option --{name} - run imp-aly help"
            )));
        };
        if kind == Kind::Switch {
            if inline.is_some() {
                return Err(Error::new(format!("--{name} takes no value")));
            }
            parsed.flags.insert(name, None);
            continue;
        }
        let value = match inline {
            Some(value) => value,
            None => {
                let next = argv.get(index).cloned();
                match next {
                    Some(value) if !(value.starts_with('-') && value.len() > 1) => {
                        index += 1;
                        value
                    }
                    _ => return Err(Error::new(format!("--{name} needs a value"))),
                }
            }
        };
        parsed.flags.insert(name, Some(value));
    }
    Ok(parsed)
}

pub fn require_only_flags(parsed: &Parsed, allowed: &[&str], command: &str) -> Result<()> {
    let extra: Vec<String> = parsed
        .flags
        .keys()
        .filter(|flag| !allowed.contains(&flag.as_str()) && flag.as_str() != "debug")
        .map(|flag| format!("--{flag}"))
        .collect();
    if !extra.is_empty() {
        return Err(Error::new(format!(
            "{command} does not take {}",
            extra.join(", ")
        )));
    }
    Ok(())
}

pub fn parse_port(value: &str) -> Result<u16> {
    match value.parse::<u32>() {
        Ok(port)
            if (1..=65535).contains(&port) && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Ok(port as u16)
        }
        _ => Err(Error::new(format!(
            "\"{value}\" is not a port - use a number from 1 to 65535"
        ))),
    }
}

pub fn parse_positive_integer(value: &str, flag: &str) -> Result<u64> {
    match value.parse::<u64>() {
        Ok(number)
            if (1..=9_007_199_254_740_991).contains(&number)
                && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Ok(number)
        }
        _ => Err(Error::new(format!(
            "{flag} \"{value}\" is not a whole number above 0"
        ))),
    }
}

pub fn parse_timeout(value: Option<&str>) -> Result<Option<u64>> {
    value
        .map(|text| parse_positive_integer(text, "--timeout").map(|seconds| seconds * 1000))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn arguments_parse_into_positionals_and_flags() {
        let parsed = parse_args(&args(&[
            "query",
            "-s",
            "eu",
            "{}",
            "--json",
            "--timeout=5",
            "--",
            "--x",
        ]))
        .unwrap();
        assert_eq!(parsed.positional, ["query", "{}", "--x"]);
        assert_eq!(parsed.get("server"), Some("eu"));
        assert!(parsed.has("json"));
        assert_eq!(parsed.get("timeout"), Some("5"));
        assert!(
            parse_args(&args(&["--nope"]))
                .unwrap_err()
                .message
                .contains("unknown option --nope")
        );
        assert!(
            parse_args(&args(&["-x"]))
                .unwrap_err()
                .message
                .contains("unknown option -x")
        );
        assert_eq!(
            parse_args(&args(&["--port"])).unwrap_err().message,
            "--port needs a value"
        );
        assert_eq!(
            parse_args(&args(&["--port", "-a"])).unwrap_err().message,
            "--port needs a value"
        );
        assert_eq!(
            parse_args(&args(&["--json=1"])).unwrap_err().message,
            "--json takes no value"
        );
        let parsed = parse_args(&args(&["server", "--max-connections", "100"])).unwrap();
        assert!(
            require_only_flags(&parsed, &["port"], "server")
                .unwrap_err()
                .message
                .contains("--max-connections")
        );
        assert_eq!(parse_port("4411").unwrap(), 4411);
        assert!(parse_port("0").is_err());
        assert!(parse_port("70000").is_err());
        assert!(parse_port("+1").is_err());
        assert_eq!(parse_timeout(Some("3")).unwrap(), Some(3000));
        assert!(parse_timeout(Some("1.5")).is_err());
        assert!(parse_timeout(Some("0")).is_err());
    }
}
