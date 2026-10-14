use crate::json::{self, Value};
use crate::records::{is_name, is_route_pattern};
use crate::url::Url;
use std::collections::BTreeSet;
use std::io::Read;
use std::time::Duration;

pub const BUILD_FILE: &str = "app-analytics.json";

pub const MAX_FILE_BYTES: usize = 3_145_728;

pub const MAX_LIST_ENTRIES: usize = 10_000;

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Lists {
    pub pages: BTreeSet<String>,
    pub zones: BTreeSet<String>,
    pub outcomes: BTreeSet<String>,
}

const SHAPE: &str =
    "an object of three lists, like {\"pages\": [\"/\"], \"zones\": [], \"outcomes\": []}";

fn read_list(build: &json::Object, key: &str) -> Result<BTreeSet<String>, String> {
    let (plural, expected, is_valid): (&str, &str, fn(&str) -> bool) = match key {
        "pages" => (
            "route patterns",
            "a route pattern - it starts with \"/\", like /invoices/:id",
            is_route_pattern,
        ),
        "zones" => (
            "zone names",
            "a zone name - a namespaced name, like myapp.send",
            is_name,
        ),
        _ => (
            "outcome names",
            "an outcome name - a namespaced name, like myapp.sent",
            is_name,
        ),
    };
    let Some(Value::Array(list)) = build.get(key) else {
        return Err(format!(
            "{BUILD_FILE} has no \"{key}\" list - it is {SHAPE}"
        ));
    };
    if list.len() > MAX_LIST_ENTRIES {
        return Err(format!(
            "{BUILD_FILE} has more than {MAX_LIST_ENTRIES} {plural} in \"{key}\""
        ));
    }
    let mut out = BTreeSet::new();
    for (index, value) in list.iter().enumerate() {
        match value {
            Value::String(text) if is_valid(text) => {
                out.insert(text.clone());
            }
            _ => {
                let shown: String = json::stringify(value).chars().take(80).collect();
                return Err(format!(
                    "{BUILD_FILE} {key}[{index}] {shown} is not {expected}"
                ));
            }
        }
    }
    Ok(out)
}

pub fn parse_build(text: &str) -> Result<Lists, String> {
    if text.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{BUILD_FILE} is larger than {MAX_FILE_BYTES} bytes"
        ));
    }
    let build =
        json::parse(text).map_err(|_| format!("{BUILD_FILE} is not JSON - it is {SHAPE}"))?;
    let Value::Object(build) = build else {
        return Err(format!("{BUILD_FILE} is not {SHAPE}"));
    };
    let pages = read_list(&build, "pages")?;
    if pages.is_empty() {
        return Err(format!("{BUILD_FILE} has no route pattern in \"pages\""));
    }
    Ok(Lists {
        pages,
        zones: read_list(&build, "zones")?,
        outcomes: read_list(&build, "outcomes")?,
    })
}

pub fn fetch_text(url: &str) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(FETCH_TIMEOUT))
        .http_status_as_error(false)
        .max_redirects(5)
        .user_agent(format!("imp-aly/{}", crate::VERSION))
        .build()
        .into();
    let response = agent
        .get(url)
        .call()
        .map_err(|error| format!("GET {url}: {error}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("GET {url} answered {status}"));
    }
    let declared = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > MAX_FILE_BYTES as u64) {
        return Err(format!(
            "GET {url}: the response is larger than {MAX_FILE_BYTES} bytes"
        ));
    }
    let mut bytes = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("GET {url}: {error}"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "GET {url}: the response is larger than {MAX_FILE_BYTES} bytes"
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn folder_url(value: &str) -> Option<String> {
    let mut url = Url::parse(value)?;
    if url.has_search() || url.has_hash() || url.has_user() {
        return None;
    }
    url.query = None;
    url.fragment = None;
    if !url.path.ends_with('/') {
        url.path.push('/');
    }
    Some(url.href())
}

pub fn build_file_url(app_url: &str) -> String {
    match Url::parse(app_url) {
        Some(url) => url.join(BUILD_FILE).href(),
        None => format!("{app_url}{BUILD_FILE}"),
    }
}

pub type FetchFile = std::sync::Arc<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

pub fn fetch_build(app_url: &str, fetch_file: &FetchFile) -> Result<Lists, String> {
    parse_build(&fetch_file(&build_file_url(app_url))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_three_lists_of_a_build() {
        let lists = parse_build(
            r#"{"pages":["/invoices","/","/"],"zones":["myapp.send"],"outcomes":["myapp.sent"],"extra":1}"#,
        )
        .unwrap();
        assert_eq!(lists.pages.iter().collect::<Vec<_>>(), ["/", "/invoices"]);
        assert_eq!(lists.zones.len(), 1);
        assert!(parse_build(r#"{"pages":["/"],"zones":[],"outcomes":[]}"#).is_ok());
    }

    #[test]
    fn rejects_a_file_that_is_not_an_object_of_three_lists() {
        assert!(parse_build("[]").unwrap_err().contains("is not an object"));
        assert!(parse_build("{").unwrap_err().contains("is not JSON"));
        assert!(
            parse_build(r#"{"pages":["/"],"zones":[]}"#)
                .unwrap_err()
                .contains("no \"outcomes\" list")
        );
        assert!(
            parse_build(r#"{"pages":[],"zones":[],"outcomes":[]}"#)
                .unwrap_err()
                .contains("no route pattern")
        );
    }

    #[test]
    fn rejects_a_bad_entry_and_names_the_list_and_the_index() {
        assert_eq!(
            parse_build(r#"{"pages":["/"],"zones":["myapp.send","noname"],"outcomes":[]}"#)
                .unwrap_err(),
            "app-analytics.json zones[1] \"noname\" is not a zone name - a namespaced name, like myapp.send"
        );
        assert_eq!(
            parse_build(r#"{"pages":["no-slash"],"zones":[],"outcomes":[]}"#).unwrap_err(),
            "app-analytics.json pages[0] \"no-slash\" is not a route pattern - it starts with \"/\", like /invoices/:id"
        );
    }

    #[test]
    fn limits_the_size_of_the_file_and_the_number_of_entries() {
        let many: Vec<String> = (0..=MAX_LIST_ENTRIES)
            .map(|at| format!("\"/{at}\""))
            .collect();
        let text = format!(
            r#"{{"pages":[{}],"zones":[],"outcomes":[]}}"#,
            many.join(",")
        );
        assert!(parse_build(&text).unwrap_err().contains("more than 10000"));
        assert!(
            parse_build(&" ".repeat(MAX_FILE_BYTES + 1))
                .unwrap_err()
                .contains("larger than")
        );
    }

    #[test]
    fn the_file_of_a_build_is_in_the_folder_of_the_app_url() {
        assert_eq!(
            folder_url("https://myapp.example").unwrap(),
            "https://myapp.example/"
        );
        assert_eq!(
            folder_url("https://myapp.example/app").unwrap(),
            "https://myapp.example/app/"
        );
        assert!(folder_url("https://myapp.example/?x=1").is_none());
        assert!(folder_url("https://user@myapp.example/").is_none());
        assert!(folder_url("myapp.example").is_none());
        assert_eq!(
            build_file_url("https://myapp.example/app/"),
            "https://myapp.example/app/app-analytics.json"
        );
    }
}
