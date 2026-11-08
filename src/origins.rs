use crate::url::Url;
use std::collections::BTreeSet;

pub fn parse_origin(text: &str) -> Result<String, String> {
    let value = text.trim();
    match Url::parse(value) {
        Some(url) if url.origin() == value => Ok(value.to_string()),
        _ => Err(format!(
            "\"{value}\" is not an origin like https://myapp.example"
        )),
    }
}

pub fn origin_of(url: &str) -> Option<String> {
    Url::parse(url).map(|url| url.origin())
}

pub struct OriginAnswer {
    pub allowed: bool,
    pub headers: Vec<(&'static str, String)>,
}

pub fn check_origin(allowed: Option<&BTreeSet<String>>, origin: Option<&str>) -> OriginAnswer {
    let vary = ("vary", "origin".to_string());
    match (allowed, origin) {
        (Some(allowed), Some(origin)) if allowed.contains(origin) => OriginAnswer {
            allowed: true,
            headers: vec![("access-control-allow-origin", origin.to_string()), vary],
        },
        (Some(_), Some(_)) => OriginAnswer {
            allowed: false,
            headers: vec![vary],
        },
        _ => OriginAnswer {
            allowed: true,
            headers: vec![vary],
        },
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

    #[test]
    fn the_origin_of_an_app_url_has_no_path() {
        assert_eq!(
            origin_of("https://myapp.example/app/").as_deref(),
            Some("https://myapp.example")
        );
        assert_eq!(
            origin_of("http://localhost:5173/").as_deref(),
            Some("http://localhost:5173")
        );
    }

    #[test]
    fn only_a_listed_origin_passes() {
        let allowed: BTreeSet<String> = ["https://myapp.example".to_string()].into();
        let listed = check_origin(Some(&allowed), Some("https://myapp.example"));
        assert!(listed.allowed);
        assert_eq!(
            listed.headers[0],
            (
                "access-control-allow-origin",
                "https://myapp.example".to_string()
            )
        );
        assert!(!check_origin(Some(&allowed), Some("https://other.example")).allowed);
        assert!(!check_origin(Some(&allowed), Some("null")).allowed);
        let direct = check_origin(Some(&allowed), None);
        assert!(direct.allowed);
        assert_eq!(direct.headers, [("vary", "origin".to_string())]);
    }
}
