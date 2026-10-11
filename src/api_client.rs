use crate::auth::find_key;
use crate::error::{Error, Result};
use crate::json::{self, Object, Value, format_number};
use crate::query_core::{Query, ServerAnswer, finalize_query, is_query_answer, parse_query};
use crate::server::DEFAULT_ADMIN_PORT;
use crate::servers::{Selection, Target, resolve_target, resolve_targets};
use crate::token::{EMPTY_BODY_HASH, create_token, sha256_hex};
use std::collections::BTreeSet;
use std::io::Read;
use std::time::Duration;

pub const QUERY_TIMEOUT_MS: u64 = 130_000;

pub const CALL_TIMEOUT_MS: u64 = 30_000;

const MAX_ANSWER_BYTES: u64 = 1 << 30;

pub fn default_url() -> String {
    format!("http://127.0.0.1:{DEFAULT_ADMIN_PORT}")
}

#[derive(Clone, Debug)]
pub struct ApiTarget {
    pub label: String,
    pub url: String,
    pub auth: Option<String>,
    pub server: Option<String>,
    pub service: bool,
}

pub fn to_api_target(target: Target) -> ApiTarget {
    let url = target.url.unwrap_or_else(default_url);
    ApiTarget {
        label: target.server.clone().unwrap_or_else(|| url.clone()),
        url,
        auth: target.auth,
        server: target.server,
        service: target.service,
    }
}

pub fn resolve_one(selection: &Selection) -> Result<ApiTarget> {
    Ok(to_api_target(resolve_target(selection)?))
}

pub fn resolve_all(selection: &Selection) -> Result<Vec<ApiTarget>> {
    Ok(resolve_targets(selection)?
        .into_iter()
        .map(to_api_target)
        .collect())
}

fn where_of(target: &ApiTarget) -> String {
    match &target.server {
        Some(server) => format!("server \"{server}\" ({})", target.url),
        None => target.url.clone(),
    }
}

fn key_of(target: &ApiTarget) -> Result<String> {
    find_key(target.auth.as_deref()).map_err(|error| {
        if target.service {
            Error::new(format!(
                "{} - the local service reads its key from this file, so run the command with sudo, or pass -a <key>",
                error.message
            ))
        } else {
            error
        }
    })
}

fn reach_hint(target: &ApiTarget) -> &'static str {
    if target.service && target.url.starts_with("https:") {
        "the local service uses TLS, so pass --url https://<host in the certificate>:<admin port>"
    } else {
        "is the server running?"
    }
}

fn late_answer(target: &ApiTarget, timeout_ms: u64) -> Error {
    Error::new(format!(
        "{} did not answer in {} s",
        where_of(target),
        format_number(timeout_ms as f64 / 1000.0)
    ))
}

pub enum Body<'a> {
    None,
    Text(String),
    Reader {
        reader: Box<dyn Read + Send + 'a>,
        length: u64,
        hash: String,
        content_type: &'a str,
    },
}

pub struct Call<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub body: Body<'a>,
    pub timeout_ms: Option<u64>,
}

pub type Response = ureq::http::Response<ureq::Body>;

fn agent(timeout_ms: Option<u64>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(timeout_ms.map(Duration::from_millis))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(format!("imp-aly/{}", crate::VERSION))
        .build()
        .into()
}

fn map_failure(error: ureq::Error, target: &ApiTarget, timeout_ms: Option<u64>) -> Error {
    match (error, timeout_ms) {
        (ureq::Error::Timeout(_), Some(timeout_ms)) => late_answer(target, timeout_ms),
        (error, _) => Error::new(format!(
            "cannot reach {} - {} ({error})",
            where_of(target),
            reach_hint(target)
        )),
    }
}

pub fn read_text(
    response: Response,
    target: &ApiTarget,
    timeout_ms: Option<u64>,
) -> Result<String> {
    let mut bytes = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_ANSWER_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut
                && let Some(timeout_ms) = timeout_ms
            {
                return late_answer(target, timeout_ms);
            }
            Error::new(format!(
                "cannot read the answer of {} ({error})",
                where_of(target)
            ))
        })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn fetch_server(target: &ApiTarget, call: Call) -> Result<Response> {
    let key = key_of(target)?;
    let hash = match &call.body {
        Body::None => EMPTY_BODY_HASH.to_string(),
        Body::Text(text) => sha256_hex(text.as_bytes()),
        Body::Reader { hash, .. } => hash.clone(),
    };
    let token = create_token(&key, call.method, call.path, &hash);
    let url = format!("{}{}", target.url.trim_end_matches('/'), call.path);
    let agent = agent(call.timeout_ms);
    let authorization = format!("Bearer {token}");
    let result = match call.body {
        Body::None => match call.method {
            "GET" => agent
                .get(&url)
                .header("authorization", &authorization)
                .call(),
            "DELETE" => agent
                .delete(&url)
                .header("authorization", &authorization)
                .call(),
            "POST" => agent
                .post(&url)
                .header("authorization", &authorization)
                .send_empty(),
            "PUT" => agent
                .put(&url)
                .header("authorization", &authorization)
                .send_empty(),
            other => return Err(Error::new(format!("the client does not send {other}"))),
        },
        Body::Text(text) => {
            let request = match call.method {
                "PUT" => agent.put(&url),
                _ => agent.post(&url),
            };
            request
                .header("authorization", &authorization)
                .header("content-type", "application/json")
                .send(text.as_bytes())
        }
        Body::Reader {
            mut reader,
            length,
            content_type,
            ..
        } => agent
            .post(&url)
            .header("authorization", &authorization)
            .header("content-type", content_type)
            .header("content-length", &length.to_string())
            .send(ureq::SendBody::from_reader(&mut reader)),
    };
    let response = result.map_err(|error| map_failure(error, target, call.timeout_ms))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = read_text(response, target, call.timeout_ms)?;
        let message = json::parse(&text)
            .ok()
            .and_then(|value| value.get_str("error").map(str::to_string))
            .unwrap_or_else(|| text.trim().to_string());
        return Err(Error::status(
            status,
            format!(
                "{} {} on {} answered {status}: {message}",
                call.method,
                call.path,
                where_of(target)
            ),
        ));
    }
    Ok(response)
}

pub fn read_json(
    response: Response,
    target: &ApiTarget,
    method: &str,
    path: &str,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    let status = response.status().as_u16();
    let text = read_text(response, target, timeout_ms)?;
    json::parse(&text).map_err(|_| {
        Error::status(
            502,
            format!(
                "{method} {path} on {} answered {status} with a reply that is not JSON",
                where_of(target)
            ),
        )
    })
}

pub fn call_server(
    target: &ApiTarget,
    method: &str,
    path: &str,
    body: Option<&Value>,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    let response = fetch_server(
        target,
        Call {
            method,
            path,
            body: body.map_or(Body::None, |value| Body::Text(json::stringify(value))),
            timeout_ms,
        },
    )?;
    read_json(response, target, method, path, timeout_ms)
}

pub struct Settled<T> {
    pub results: Vec<(String, T)>,
    pub failed: Vec<(String, String)>,
}

pub fn each_server<T: Send>(
    targets: &[ApiTarget],
    run: impl Fn(&ApiTarget) -> Result<T> + Sync,
) -> Result<Settled<T>> {
    let outcomes: Vec<Result<T>> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .iter()
            .map(|target| scope.spawn(|| run(target)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err(Error::new("the call failed")))
            })
            .collect()
    });
    if targets.len() == 1
        && let Some(Err(error)) = outcomes.first()
    {
        return Err(error.clone());
    }
    let mut settled = Settled {
        results: Vec::new(),
        failed: Vec::new(),
    };
    for (target, outcome) in targets.iter().zip(outcomes) {
        match outcome {
            Ok(result) => settled.results.push((target.label.clone(), result)),
            Err(error) => settled.failed.push((target.label.clone(), error.message)),
        }
    }
    Ok(settled)
}

fn no_server_answered(failed: &[(String, String)]) -> Error {
    Error::status(
        502,
        format!(
            "no server answered:\n{}",
            failed
                .iter()
                .map(|(_, reason)| format!("  {reason}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
}

fn config_warnings(app: &str, answers: &[(String, Value)]) -> Vec<String> {
    let missing: Vec<&str> = answers
        .iter()
        .filter(|(_, answer)| answer.get("appConfig").is_none_or(Value::is_null))
        .map(|(server, _)| server.as_str())
        .collect();
    let configs: BTreeSet<String> = answers
        .iter()
        .filter_map(|(_, answer)| answer.get("appConfig").filter(|value| !value.is_null()))
        .map(json::stringify)
        .collect();
    let mut warnings = Vec::new();
    if !missing.is_empty() && missing.len() < answers.len() {
        warnings.push(format!(
            "the app {app} is not registered on: {}",
            missing.join(", ")
        ));
    }
    if configs.len() > 1 {
        warnings.push(format!(
            "the app {app} has different builds or different segments on the servers"
        ));
    }
    warnings
}

pub struct QueryResult {
    pub parsed: Query,
    pub result: Object,
    pub warnings: Vec<String>,
    pub failed: Vec<(String, String)>,
}

pub fn query_servers(
    targets: &[ApiTarget],
    body: &Value,
    timeout_ms: Option<u64>,
) -> Result<QueryResult> {
    let parsed = parse_query(body, crate::days::now_ms())?;
    let mut request = match body {
        Value::Object(object) => object.clone(),
        _ => Object::new(),
    };
    request.insert("from", parsed.from.clone());
    request.insert("to", parsed.to.clone());
    let request = Value::Object(request);
    let timeout = Some(timeout_ms.unwrap_or(QUERY_TIMEOUT_MS));
    let outcomes: Vec<Result<Value>> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .iter()
            .map(|target| {
                let request = &request;
                scope.spawn(move || {
                    let answer = call_server(target, "POST", "/query", Some(request), timeout)?;
                    if !is_query_answer(&answer) {
                        return Err(Error::status(
                            502,
                            format!("{} sent a reply that is not a query answer", target.label),
                        ));
                    }
                    Ok(answer)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err(Error::new("the query failed")))
            })
            .collect()
    });
    let mut answers = Vec::new();
    let mut failed = Vec::new();
    for (target, outcome) in targets.iter().zip(outcomes) {
        match outcome {
            Ok(answer) => answers.push((target.label.clone(), answer)),
            Err(error) => {
                if targets.len() == 1 {
                    return Err(error);
                }
                failed.push((target.label.clone(), error.message));
            }
        }
    }
    if answers.is_empty() {
        return Err(no_server_answered(&failed));
    }
    let server_answers: Vec<ServerAnswer> = answers
        .iter()
        .map(|(server, answer)| ServerAnswer {
            server: server.clone(),
            answer: answer.clone(),
        })
        .collect();
    let mut result = finalize_query(&parsed, &server_answers);
    result.insert(
        "failedServers",
        Value::Array(
            failed
                .iter()
                .map(|(server, reason)| {
                    Object::new()
                        .with("server", server.clone())
                        .with("reason", reason.clone())
                        .into()
                })
                .collect(),
        ),
    );
    let warnings = config_warnings(&parsed.app, &answers);
    Ok(QueryResult {
        parsed,
        result,
        warnings,
        failed,
    })
}

pub fn require_answer<T>(settled: Settled<T>) -> Result<Settled<T>> {
    if settled.results.is_empty() && !settled.failed.is_empty() {
        return Err(no_server_answered(&settled.failed));
    }
    Ok(settled)
}
