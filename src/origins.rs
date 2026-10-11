use crate::url::Url;
use std::collections::HashSet;

pub fn parse_origin(text: &str) -> Result<String, String> {
    let value = text.trim();
    match Url::parse(value) {
        Some(url) if url.origin() == value => Ok(value.to_string()),
        _ => Err(format!(
            "\"{value}\" is not an origin like https://myapp.example"
        )),
    }
}

pub fn parse_origins(list: &[String]) -> Result<Vec<String>, String> {
    list.iter().map(|entry| parse_origin(entry)).collect()
}

pub struct OriginAnswer {
    pub allowed: bool,
    pub headers: Vec<(&'static str, String)>,
}

pub struct OriginCheck {
    origins: Option<HashSet<String>>,
}

impl OriginCheck {
    pub fn new(allowed: Option<&[String]>) -> Result<Self, String> {
        match allowed {
            Some(list) if !list.is_empty() => Ok(OriginCheck {
                origins: Some(parse_origins(list)?.into_iter().collect()),
            }),
            _ => Ok(OriginCheck { origins: None }),
        }
    }

    pub fn check(&self, origin: Option<&str>) -> OriginAnswer {
        let Some(origins) = &self.origins else {
            return OriginAnswer {
                allowed: true,
                headers: vec![("access-control-allow-origin", "*".to_string())],
            };
        };
        let vary = ("vary", "origin".to_string());
        match origin {
            None => OriginAnswer {
                allowed: true,
                headers: vec![vary],
            },
            Some(origin) if origins.contains(origin) => OriginAnswer {
                allowed: true,
                headers: vec![("access-control-allow-origin", origin.to_string()), vary],
            },
            Some(_) => OriginAnswer {
                allowed: false,
                headers: vec![vary],
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_origin_is_a_scheme_a_host_and_a_port() {
        assert!(parse_origin("https://myapp.example").is_ok());
        assert!(parse_origin("http://localhost:3000").is_ok());
        assert!(parse_origin("https://myapp.example/").is_err());
        assert!(parse_origin("https://MyApp.example").is_err());
        assert!(parse_origin("https://myapp.example:443").is_err());
        assert!(parse_origin("ftp://myapp.example").is_err());
        assert!(parse_origin("myapp.example").is_err());
    }
}
