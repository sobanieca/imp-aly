use crate::app_build::{FetchFile, fetch_text};
use crate::apps::Apps;
use crate::backup::{parse_backup_options, write_backup};
use crate::data_format::{DATA_FORMAT, check_data_format};
use crate::days::{day_of, iso, now_ms};
use crate::error::{Error, Result};
use crate::file_watch::{WatchHandle, watch_files};
use crate::fsutil::{create_dir_all, remove_if_exists};
use crate::http::{
    BoxFuture, Handler, HttpError, Limits, Listener, Request, Response, ResponseBody, TlsConfig,
    serve,
};
use crate::in_flight::InFlight;
use crate::json::{self, Object, Value, format_number};
use crate::live::LiveDays;
use crate::logger;
use crate::names::is_app_name;
use crate::origins::check_origin;
use crate::paths::join;
use crate::query::QueryEngine;
use crate::query_core::{Query, parse_query};
use crate::rate_limit::{
    ClientKey, DEFAULT_MAX_CLIENTS, DEFAULT_TRUSTED_PROXIES, RateLimiter, Window, client_address,
    client_keys, default_limits, is_trusted, max_batch, parse_trusted_proxies,
};
use crate::records::{DEFAULT_SEAL_DELAY_MS, normalize_country, validate_record};
use crate::retention::{DEFAULT_MIN_FREE, parse_min_free};
use crate::source::open_source;
use crate::storage::{DEFAULT_MAINTENANCE_MS, StorageOptions, StorageRunner};
use crate::token::{EMPTY_BODY_HASH, Sha256, TokenVerifier, hex, random_bytes, sha256_hex};
use crate::url::search_params;
use crate::wal::{DEFAULT_SEGMENT_BYTES, DEFAULT_SEGMENT_MS, Wal, WalOptions};
use crate::{VERSION, bots};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, mpsc};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

pub const DEFAULT_PORT: u16 = 4411;

pub const DEFAULT_ADMIN_PORT: u16 = 4410;

pub const COLLECT_MAX_BYTES: usize = 65_536;

pub const DEFAULT_MAX_REQUESTS: usize = 1_024;

pub const COLLECT_TIMEOUT_MS: u64 = 5_000;

pub const RESTORE_IDLE_MS: u64 = 30_000;

const BUSY_RETRY_SECONDS: &str = "5";

const ADMIN_MAX_BYTES: usize = 4_194_304;

const ADMIN_BODY_TIMEOUT: Duration = Duration::from_secs(10);

const RESTORE_MAX_BYTES: u64 = 4_294_967_296;

pub const QUERY_TIMEOUT_MS: u64 = 120_000;

const MAX_QUEUED_QUERIES: usize = 16;

const BUILD_REFRESH_MS: u64 = 600_000;

pub const TLS_CHECK_MS: u64 = 3_600_000;

const SECURITY_HEADERS: [(&str, &str); 2] = [
    ("x-content-type-options", "nosniff"),
    (
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'",
    ),
];

const PREFLIGHT_HEADERS: [(&str, &str); 3] = [
    ("access-control-allow-methods", "POST"),
    ("access-control-allow-headers", "content-type"),
    ("access-control-max-age", "86400"),
];

const ADMIN_CORS_HEADERS: [(&str, &str); 2] = [
    ("access-control-allow-origin", "*"),
    ("access-control-expose-headers", "content-disposition"),
];

const ADMIN_PREFLIGHT_HEADERS: [(&str, &str); 3] = [
    ("access-control-allow-methods", "GET, POST, PUT, DELETE"),
    (
        "access-control-allow-headers",
        "authorization, content-type",
    ),
    ("access-control-max-age", "86400"),
];

const ADMIN_PATHS: [&str; 5] = ["/status", "/query", "/apps", "/backup", "/restore"];

pub type OnTlsChange = Arc<dyn Fn() -> bool + Send + Sync>;

type Waker = Box<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct ServerOptions {
    pub port: u16,
    pub hostname: Option<String>,
    pub admin_port: u16,
    pub admin_hostname: Option<String>,
    pub data_dir: String,
    pub key: String,
    pub ip_header: Option<String>,
    pub trusted_proxies: Vec<String>,
    pub country_header: Option<String>,
    pub limits: Vec<Window>,
    pub max_clients: usize,
    pub max_requests: usize,
    pub max_client_requests: Option<usize>,
    pub max_connections: usize,
    pub collect_timeout_ms: u64,
    pub restore_idle_ms: u64,
    pub min_free: Option<String>,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
    pub tls_watch: Option<Vec<String>>,
    pub tls_check_ms: u64,
    pub on_tls_change: Option<OnTlsChange>,
    pub segment_ms: u64,
    pub seal_delay_ms: i64,
    pub maintenance_ms: i64,
    pub build_refresh_ms: u64,
    pub query_timeout_ms: u64,
    pub fetch_file: Option<FetchFile>,
    pub http: Option<Limits>,
}

impl ServerOptions {
    pub fn new(data_dir: &str, key: &str) -> Self {
        ServerOptions {
            port: DEFAULT_PORT,
            hostname: None,
            admin_port: DEFAULT_ADMIN_PORT,
            admin_hostname: None,
            data_dir: data_dir.to_string(),
            key: key.to_string(),
            ip_header: None,
            trusted_proxies: DEFAULT_TRUSTED_PROXIES
                .iter()
                .map(|entry| entry.to_string())
                .collect(),
            country_header: None,
            limits: default_limits(),
            max_clients: DEFAULT_MAX_CLIENTS,
            max_requests: DEFAULT_MAX_REQUESTS,
            max_client_requests: None,
            max_connections: crate::http::DEFAULT_MAX_CONNECTIONS,
            collect_timeout_ms: COLLECT_TIMEOUT_MS,
            restore_idle_ms: RESTORE_IDLE_MS,
            min_free: Some(DEFAULT_MIN_FREE.to_string()),
            tls_cert: None,
            tls_key: None,
            tls_watch: None,
            tls_check_ms: TLS_CHECK_MS,
            on_tls_change: None,
            segment_ms: DEFAULT_SEGMENT_MS,
            seal_delay_ms: DEFAULT_SEAL_DELAY_MS,
            maintenance_ms: DEFAULT_MAINTENANCE_MS,
            build_refresh_ms: BUILD_REFRESH_MS,
            query_timeout_ms: QUERY_TIMEOUT_MS,
            fetch_file: None,
            http: None,
        }
    }
}

struct QueryJob {
    query: Query,
    started: oneshot::Sender<()>,
    reply: oneshot::Sender<Result<Value>>,
    cancelled: Arc<AtomicBool>,
}

struct QueryRunner {
    sender: Mutex<Option<mpsc::Sender<QueryJob>>>,
    queued: AtomicUsize,
    timeout_ms: u64,
    current: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl QueryRunner {
    fn start(data_dir: String, timeout_ms: u64, live: Arc<LiveDays>) -> Result<QueryRunner> {
        let (sender, receiver) = mpsc::channel::<QueryJob>();
        let current: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));
        let running = current.clone();
        std::thread::Builder::new()
            .name("imp-aly-query".to_string())
            .spawn(move || {
                let engine = QueryEngine::default().with_live(live);
                while let Ok(job) = receiver.recv() {
                    if job.started.send(()).is_err() || job.cancelled.load(Ordering::Relaxed) {
                        continue;
                    }
                    *running.lock().unwrap_or_else(|poison| poison.into_inner()) =
                        Some(job.cancelled.clone());
                    let cancelled = job.cancelled.clone();
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        engine.run(&data_dir, &job.query, &|| cancelled.load(Ordering::Relaxed))
                    }));
                    *running.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
                    let result = outcome.unwrap_or_else(|_| {
                        logger::error("The query worker failed");
                        Err(Error::new("the query worker failed"))
                    });
                    let _ = job.reply.send(result);
                }
            })
            .map_err(|error| Error::new(format!("cannot start the query worker: {error}")))?;
        Ok(QueryRunner {
            sender: Mutex::new(Some(sender)),
            queued: AtomicUsize::new(0),
            timeout_ms,
            current,
        })
    }

    async fn run(&self, query: Query) -> Result<Value> {
        if self.queued.fetch_add(1, Ordering::SeqCst) >= MAX_QUEUED_QUERIES {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return Err(Error::status(
                503,
                "too many queries wait - try again later",
            ));
        }
        struct Leave<'a>(&'a AtomicUsize);
        impl Drop for Leave<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _leave = Leave(&self.queued);
        let (started, wait_start) = oneshot::channel();
        let (reply, answer) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = QueryJob {
            query,
            started,
            reply,
            cancelled: cancelled.clone(),
        };
        let sent = self
            .sender
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_ref()
            .is_some_and(|sender| sender.send(job).is_ok());
        if !sent {
            return Err(Error::status(503, "the server stops"));
        }
        struct Cancel(Arc<AtomicBool>);
        impl Drop for Cancel {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let _cancel = Cancel(cancelled.clone());
        if wait_start.await.is_err() {
            return Err(Error::status(503, "the server stops"));
        }
        match tokio::time::timeout(Duration::from_millis(self.timeout_ms), answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::new("the query worker failed")),
            Err(_) => {
                cancelled.store(true, Ordering::Relaxed);
                Err(Error::status(
                    504,
                    format!(
                        "the query took longer than {} s",
                        format_number(self.timeout_ms as f64 / 1000.0)
                    ),
                ))
            }
        }
    }

    fn close(&self) {
        self.sender
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(current) = self
            .current
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_ref()
        {
            current.store(true, Ordering::Relaxed);
        }
    }
}

struct State {
    data_dir: String,
    source: String,
    started_at: String,
    apps: Arc<Apps>,
    wal: Wal,
    storage: Arc<StorageRunner>,
    queries: QueryRunner,
    limiter: Mutex<RateLimiter>,
    batch_limit: u64,
    verifier: Mutex<TokenVerifier>,
    public_flight: InFlight,
    admin_flight: InFlight,
    ip_header: Option<String>,
    trusted: Vec<crate::ip::Network>,
    country_header: Option<String>,
    collect_timeout: Duration,
    restore_idle_ms: u64,
    seal_delay_ms: i64,
    upload_dir: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Port {
    Public,
    Admin,
}

struct PortHandler {
    state: Arc<State>,
    port: Port,
}

fn header_list(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

fn secure(mut response: Response, headers: &[(String, String)]) -> Response {
    for (name, value) in headers {
        response.set_header(name, value);
    }
    for (name, value) in SECURITY_HEADERS {
        response.set_header(name, value);
    }
    response
}

fn json_response(status: u16, value: Value) -> Response {
    Response::json(status, &value)
}

fn from_http(error: HttpError) -> Error {
    Error::status(error.status, error.message)
}

fn body_mismatch() -> Error {
    Error::status(401, "unauthorized: the body does not match the token")
}

fn version_response() -> Response {
    Response::text(200, &format!("imp-aly {VERSION}\n"), "text/plain")
}

fn read_token(request: &Request) -> String {
    let header = request.header("authorization").unwrap_or("").trim();
    let mut parts = header.splitn(2, |c: char| c.is_whitespace());
    let scheme = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim_start();
    if !scheme.eq_ignore_ascii_case("bearer")
        || rest.is_empty()
        || rest.contains(char::is_whitespace)
    {
        return String::new();
    }
    rest.to_string()
}

fn parse_json_bytes(bytes: &[u8]) -> Result<Value> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| Error::status(400, "the body is not UTF-8 text"))?;
    json::parse(text).map_err(|_| Error::status(400, "the body is not valid JSON"))
}

impl State {
    fn client_keys(&self, request: &Request) -> Vec<ClientKey> {
        let remote = request.peer.to_string();
        let header = self
            .ip_header
            .as_deref()
            .and_then(|name| request.header(name));
        client_keys(&client_address(
            &remote,
            header,
            self.ip_header.as_deref(),
            &self.trusted,
        ))
    }

    async fn collect(
        &self,
        request: &mut Request,
        clients: &[ClientKey],
        name: &str,
        headers: &[(String, String)],
    ) -> Result<Response> {
        let rules = if is_app_name(name) {
            self.apps.rules(name)
        } else {
            None
        };
        let Some(rules) = rules else {
            return Err(Error::status(
                404,
                format!("no app \"{name}\" is registered"),
            ));
        };
        let bytes = request
            .body
            .read_all(COLLECT_MAX_BYTES, self.collect_timeout)
            .await
            .map_err(from_http)?;
        let body = parse_json_bytes(&bytes)?;
        let inputs: Vec<&Value> = match &body {
            Value::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        if inputs.len() as u64 > self.batch_limit {
            return Err(Error::status(
                413,
                format!("a request holds at most {} records", self.batch_limit),
            ));
        }
        let extra = inputs.len().saturating_sub(1) as u64;
        let over = self
            .limiter
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take(clients, extra, now_ms() as u64);
        if let Some(window) = over {
            return Err(Error::status(
                429,
                format!("too many records from this address in {}", window.name),
            ));
        }
        let country = self
            .country_header
            .as_deref()
            .and_then(|header| normalize_country(request.header(header)));
        let bot = bots::bot_problem(
            request.header("sec-purpose"),
            request.header("purpose"),
            request.header("user-agent"),
        );
        let now = now_ms();
        let mut lines = String::new();
        let mut accepted = 0u64;
        let mut rejected = 0u64;
        for input in inputs {
            let outcome = match bot {
                Some(problem) => Err(problem.to_string()),
                None => validate_record(
                    input,
                    &rules.lists,
                    &rules.segments,
                    country.as_deref(),
                    now,
                ),
            };
            match outcome {
                Err(problem) => {
                    rejected += 1;
                    self.apps.count_rejected(name, &problem);
                    logger::debug(format!("Rejected a record of {name}: {problem}"));
                }
                Ok(record) => {
                    let at = record
                        .get("at")
                        .and_then(Value::as_safe_integer)
                        .unwrap_or(now);
                    let line = Value::Array(vec![
                        Value::from(name),
                        Value::from(day_of(at)),
                        Value::Object(record),
                    ]);
                    lines.push_str(&json::stringify(&line));
                    lines.push('\n');
                    accepted += 1;
                }
            }
        }
        if accepted > 0 {
            if let Err(error) = self.wal.append(lines).await {
                logger::error(format!("The write-ahead log failed: {error}"));
                return Err(Error::status(503, "the server cannot store records now"));
            }
            self.apps.count_accepted(name, accepted);
        }
        Ok(secure(
            json_response(
                202,
                Object::new()
                    .with("accepted", accepted)
                    .with("rejected", rejected)
                    .into(),
            ),
            headers,
        ))
    }

    async fn read_admin_body(&self, request: &mut Request, body_hash: &str) -> Result<Value> {
        let bytes = request
            .body
            .read_all(ADMIN_MAX_BYTES, ADMIN_BODY_TIMEOUT)
            .await
            .map_err(from_http)?;
        if sha256_hex(&bytes) != body_hash {
            return Err(body_mismatch());
        }
        parse_json_bytes(&bytes)
    }

    async fn save_upload(&self, request: &mut Request, body_hash: &str) -> Result<String> {
        let too_large = || {
            Error::status(
                413,
                format!("a backup is at most {RESTORE_MAX_BYTES} bytes"),
            )
        };
        if request
            .body
            .declared_length()
            .is_some_and(|length| length > RESTORE_MAX_BYTES)
        {
            return Err(too_large());
        }
        if !request.body.has_body() {
            return Err(Error::status(400, "send the backup file as the body"));
        }
        create_dir_all(&self.upload_dir)?;
        let path = join(&[
            &self.upload_dir,
            &format!("{}.tar.gz", hex(&random_bytes(16))),
        ]);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| Error::io(&error, &path))?;
        let idle = Duration::from_millis(self.restore_idle_ms);
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let outcome: Result<()> = async {
            loop {
                let chunk = match request.body.next_chunk_within(idle).await {
                    Ok(chunk) => chunk,
                    Err(error) if error.status == 408 => {
                        return Err(Error::status(
                            408,
                            format!(
                                "the backup sent no bytes for {} s",
                                format_number(self.restore_idle_ms as f64 / 1000.0)
                            ),
                        ));
                    }
                    Err(error) => return Err(from_http(error)),
                };
                let Some(chunk) = chunk else {
                    return Ok(());
                };
                total += chunk.len() as u64;
                if total > RESTORE_MAX_BYTES {
                    return Err(too_large());
                }
                hash.update(&chunk);
                file.write_all(&chunk)
                    .map_err(|error| Error::io(&error, &path))?;
            }
        }
        .await;
        drop(file);
        if let Err(error) = outcome {
            let _ = remove_if_exists(&path);
            return Err(error);
        }
        if hash.hex() != body_hash {
            let _ = remove_if_exists(&path);
            return Err(body_mismatch());
        }
        Ok(path)
    }

    async fn admin(&self, request: &mut Request) -> Result<Response> {
        let method = request.method.clone();
        let path = request.path.clone();
        let token = read_token(request);
        let verified = self
            .verifier
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .verify(&token, &method, &request.target);
        let body_hash = match verified {
            Ok(verified) => verified.body_hash,
            Err(problem) => return Err(Error::status(401, format!("unauthorized: {problem}"))),
        };
        let no_body = || {
            if body_hash != EMPTY_BODY_HASH {
                return Err(body_mismatch());
            }
            Ok(())
        };
        if path == "/status" && method == "GET" {
            no_body()?;
            let status = Object::new()
                .with("version", VERSION)
                .with("dataFormat", DATA_FORMAT)
                .with("startedAt", self.started_at.clone())
                .with("dataDir", self.data_dir.clone())
                .with("source", self.source.clone())
                .with("apps", self.apps.count())
                .with(
                    "rateLimitedClients",
                    self.limiter
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .size(),
                )
                .with(
                    "activeRequests",
                    Object::new()
                        .with("public", self.public_flight.count())
                        .with("admin", self.admin_flight.count()),
                )
                .with("storage", self.storage.status());
            return Ok(json_response(200, status.into()));
        }
        if path == "/query" && method == "POST" {
            let body = self.read_admin_body(request, &body_hash).await?;
            let query = parse_query(&body, now_ms())?;
            let app = query.app.clone();
            let answer = self.queries.run(query).await?;
            let mut answer = match answer {
                Value::Object(object) => object,
                _ => Object::new(),
            };
            answer.insert("appConfig", self.apps.config(&app));
            return Ok(json_response(200, answer.into()));
        }
        if path == "/backup" && method == "GET" {
            no_body()?;
            let options = parse_backup_options(&search_params(&request.query))?;
            let (sender, receiver) = tokio::sync::mpsc::channel(8);
            let data_dir = self.data_dir.clone();
            let seal_delay_ms = self.seal_delay_ms;
            tokio::task::spawn_blocking(move || {
                let writer = ChannelWriter {
                    sender: sender.clone(),
                    buffer: Vec::new(),
                };
                if let Err(error) = write_backup(
                    &data_dir,
                    &options.last,
                    &options.by,
                    now_ms(),
                    seal_delay_ms,
                    writer,
                ) {
                    logger::warn(format!("The backup stopped: {error}"));
                    let _ = sender.blocking_send(Err(error));
                }
            });
            let mut response = Response::new(200)
                .header("content-type", "application/gzip")
                .header(
                    "content-disposition",
                    "attachment; filename=\"imp-aly-backup.tar.gz\"",
                );
            response.body = ResponseBody::Stream(receiver);
            return Ok(response);
        }
        if path == "/restore" && method == "POST" {
            let upload = self.save_upload(request, &body_hash).await?;
            let result = self.storage.restore(upload.clone()).await;
            let _ = remove_if_exists(&upload);
            return Ok(json_response(200, result?));
        }
        if path == "/apps" && method == "GET" {
            no_body()?;
            return Ok(json_response(
                200,
                Object::new().with("apps", self.apps.list()).into(),
            ));
        }
        if let Some(rest) = path.strip_prefix("/apps/") {
            let (name, refresh) = match rest.strip_suffix("/refresh") {
                Some(name) => (name, true),
                None => (rest, false),
            };
            if !name.is_empty() && !name.contains('/') {
                let name = name.to_string();
                if !refresh {
                    match method.as_str() {
                        "GET" => {
                            no_body()?;
                            return Ok(json_response(200, self.apps.describe(&name)?));
                        }
                        "PUT" => {
                            let body = self.read_admin_body(request, &body_hash).await?;
                            let apps = self.apps.clone();
                            let described =
                                tokio::task::spawn_blocking(move || apps.put(&name, &body))
                                    .await
                                    .map_err(|_| Error::new("the app registry failed"))??;
                            return Ok(json_response(200, described));
                        }
                        "DELETE" => {
                            no_body()?;
                            let apps = self.apps.clone();
                            let removed = name.clone();
                            tokio::task::spawn_blocking(move || apps.remove(&removed))
                                .await
                                .map_err(|_| Error::new("the app registry failed"))??;
                            return Ok(json_response(
                                200,
                                Object::new().with("removed", name).into(),
                            ));
                        }
                        _ => {}
                    }
                } else if method == "POST" {
                    no_body()?;
                    let apps = self.apps.clone();
                    let described = tokio::task::spawn_blocking(move || apps.refresh(&name))
                        .await
                        .map_err(|_| Error::new("the app registry failed"))??;
                    return Ok(json_response(200, described));
                }
            }
        }
        Err(Error::status(
            404,
            format!("{method} {path} is not an endpoint"),
        ))
    }

    async fn public_route(
        &self,
        request: &mut Request,
        clients: &[ClientKey],
        allowed: bool,
        headers: &[(String, String)],
    ) -> Result<Response> {
        let path = request.path.clone();
        if let Some(name) = path.strip_prefix("/collect/")
            && !name.is_empty()
            && !name.contains('/')
        {
            if !is_app_name(name) || self.apps.origins(name).is_none() {
                return Err(Error::status(
                    404,
                    format!("no app \"{name}\" is registered"),
                ));
            }
            if !allowed {
                return Err(Error::status(
                    403,
                    format!("this origin cannot send records of \"{name}\""),
                ));
            }
            if request.method == "OPTIONS" {
                let mut response = Response::new(204);
                for (name, value) in PREFLIGHT_HEADERS {
                    response.set_header(name, value);
                }
                return Ok(response);
            }
            if request.method != "POST" {
                return Err(Error::status(405, "send records with POST"));
            }
            let name = name.to_string();
            return self.collect(request, clients, &name, headers).await;
        }
        if path == "/" && request.method == "GET" {
            return Ok(version_response());
        }
        Err(Error::status(
            404,
            format!("{} {path} is not an endpoint", request.method),
        ))
    }

    async fn admin_route(&self, request: &mut Request) -> Result<Response> {
        if request.method == "OPTIONS" {
            let mut response = Response::new(204);
            for (name, value) in ADMIN_PREFLIGHT_HEADERS {
                response.set_header(name, value);
            }
            return Ok(response);
        }
        if request.path == "/" && request.method == "GET" {
            return Ok(version_response());
        }
        if ADMIN_PATHS.contains(&request.path.as_str()) || request.path.starts_with("/apps/") {
            return self.admin(request).await;
        }
        Err(Error::status(
            404,
            format!("{} {} is not an endpoint", request.method, request.path),
        ))
    }
}

struct ChannelWriter {
    sender: tokio::sync::mpsc::Sender<std::io::Result<Vec<u8>>>,
    buffer: Vec<u8>,
}

impl Write for ChannelWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() >= 65_536 {
            self.flush()?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = std::mem::take(&mut self.buffer);
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the client left"))
    }
}

impl PortHandler {
    async fn respond(&self, request: &mut Request) -> Response {
        let state = &self.state;
        let collect = match self.port {
            Port::Public => request.path.strip_prefix("/collect/"),
            Port::Admin => None,
        };
        let (allowed, headers) = if let Some(name) = collect {
            let origins = state.apps.origins(name);
            let answer = check_origin(origins.as_deref(), request.header("origin"));
            (
                answer.allowed,
                answer
                    .headers
                    .into_iter()
                    .map(|(name, value)| (name.to_string(), value))
                    .collect::<Vec<_>>(),
            )
        } else if self.port == Port::Admin {
            (true, header_list(&ADMIN_CORS_HEADERS))
        } else {
            (true, Vec::new())
        };
        let mut retry = headers.clone();
        retry.push(("retry-after".to_string(), BUSY_RETRY_SECONDS.to_string()));
        let counter = match self.port {
            Port::Public => &state.public_flight,
            Port::Admin => &state.admin_flight,
        };
        if counter.full() {
            return secure(
                Response::error(503, "the server is busy, try again later"),
                &retry,
            );
        }
        let clients = state.client_keys(request);
        let Some(_ticket) = counter.enter(&clients) else {
            return secure(
                Response::error(429, "too many requests in progress from this address"),
                &retry,
            );
        };
        let exceeded = state
            .limiter
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take(&clients, 1, now_ms() as u64);
        if let Some(window) = exceeded {
            return secure(
                Response::error(
                    429,
                    &format!("too many requests from this address in {}", window.name),
                ),
                &headers,
            );
        }
        let routed = match self.port {
            Port::Public => {
                state
                    .public_route(request, &clients, allowed, &headers)
                    .await
            }
            Port::Admin => state.admin_route(request).await,
        };
        match routed {
            Ok(response) => secure(response, &headers),
            Err(error) => match error.status {
                Some(status) => secure(Response::error(status, &error.message), &headers),
                None => {
                    logger::error(&error.message);
                    secure(Response::error(500, "internal error"), &headers)
                }
            },
        }
    }
}

impl Handler for PortHandler {
    fn handle<'a>(&'a self, request: &'a mut Request) -> BoxFuture<'a, Response> {
        Box::pin(self.respond(request))
    }
}

fn acquire_lock(data_dir: &str) -> Result<File> {
    let path = join(&[data_dir, "lock"]);
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| Error::io(&error, &path))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(_) => Err(Error::new(format!(
            "another imp-aly already uses the data folder {data_dir}"
        ))),
    }
}

pub fn load_tls(cert: &str, key: &str) -> Result<rustls::ServerConfig> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|error| Error::new(format!("cannot read the certificate {cert}: {error}")))?
        .collect::<std::result::Result<_, _>>()
        .map_err(|error| Error::new(format!("cannot read the certificate {cert}: {error}")))?;
    if certs.is_empty() {
        return Err(Error::new(format!("{cert} holds no certificate")));
    }
    let private = PrivateKeyDer::from_pem_file(key)
        .map_err(|error| Error::new(format!("cannot read the private key {key}: {error}")))?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| Error::new(format!("TLS: {error}")))?
    .with_no_client_auth()
    .with_single_cert(certs, private)
    .map_err(|error| Error::new(format!("the certificate and the key do not work: {error}")))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

async fn bind(port: u16, hostname: Option<&str>) -> Result<TcpListener> {
    let listen = |host: String| async move {
        TcpListener::bind((host.as_str(), port))
            .await
            .map_err(|error| {
                let message = if error.kind() == std::io::ErrorKind::AddrInUse {
                    format!("the port {port} is in use on {host}")
                } else {
                    format!("cannot listen on {host} port {port}: {error}")
                };
                Error::new(message)
            })
    };
    match hostname {
        Some(host) => listen(host.trim_matches(['[', ']']).to_string()).await,
        None => match TcpListener::bind(("::", port)).await {
            Ok(listener) => Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                Err(Error::new(format!("the port {port} is in use")))
            }
            Err(_) => listen("0.0.0.0".to_string()).await,
        },
    }
}

pub struct RunningServer {
    pub port: u16,
    pub hostname: String,
    pub admin_port: u16,
    pub admin_hostname: String,
    state: Arc<State>,
    shutdown: watch::Sender<bool>,
    serving: Vec<JoinHandle<()>>,
    background: Vec<JoinHandle<()>>,
    watcher: Option<WatchHandle>,
    lock: Option<File>,
}

impl RunningServer {
    pub fn set_key(&self, key: &str) -> Result<()> {
        if key.is_empty() {
            return Err(Error::new("the server needs a key"));
        }
        *self
            .state
            .verifier
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = TokenVerifier::new(key);
        Ok(())
    }

    pub fn stopper(&self) -> watch::Sender<bool> {
        self.shutdown.clone()
    }

    pub async fn shutdown(mut self) {
        let _ = self.shutdown.send(true);
        for task in self.serving.drain(..) {
            let _ = task.await;
        }
        for task in self.background.drain(..) {
            task.abort();
        }
        if let Some(watcher) = self.watcher.take() {
            watcher.stop();
        }
        self.state.queries.close();
        let storage = self.state.storage.clone();
        let _ = tokio::task::spawn_blocking(move || storage.stop()).await;
        let state = self.state.clone();
        let _ = tokio::task::spawn_blocking(move || state.wal_close()).await;
        self.lock.take();
    }
}

impl State {
    fn wal_close(&self) {
        self.wal.close_shared();
    }
}

pub async fn start_server(options: ServerOptions) -> Result<RunningServer> {
    if options.key.is_empty() {
        return Err(Error::new("the server needs a key"));
    }
    if options.port != 0 && options.port == options.admin_port {
        return Err(Error::new(
            "the public port and the admin port must be different",
        ));
    }
    let min_free = match &options.min_free {
        Some(text) => Some(parse_min_free(text).map_err(Error::new)?),
        None => None,
    };
    let trusted = parse_trusted_proxies(&options.trusted_proxies).map_err(Error::new)?;
    let data_dir = options.data_dir.clone();
    create_dir_all(&data_dir)?;
    let lock = acquire_lock(&data_dir)?;
    check_data_format(&data_dir)?;
    let source = open_source(&data_dir)?;
    let upload_dir = join(&[&data_dir, "restore"]);
    remove_if_exists(&upload_dir)?;
    let fetch_file = options
        .fetch_file
        .clone()
        .unwrap_or_else(|| Arc::new(fetch_text));
    let apps = Arc::new(Apps::open(&data_dir, fetch_file)?);
    let waker: Arc<Mutex<Option<Waker>>> = Arc::new(Mutex::new(None));
    let wake_slot = waker.clone();
    let wal = Wal::open(WalOptions {
        dir: join(&[&data_dir, "wal"]),
        segment_ms: options.segment_ms,
        segment_bytes: DEFAULT_SEGMENT_BYTES,
        on_segment: Box::new(move |_| {
            if let Some(wake) = wake_slot
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .as_ref()
            {
                wake();
            }
        }),
    })?;
    let mut storage_options = StorageOptions::new(&data_dir, &source);
    storage_options.min_free = min_free;
    storage_options.seal_delay_ms = options.seal_delay_ms;
    storage_options.maintenance_ms = options.maintenance_ms;
    let live = storage_options.live.clone();
    let storage = Arc::new(StorageRunner::start(storage_options)?);
    *waker.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(Box::new(storage.waker()));
    let queries = QueryRunner::start(data_dir.clone(), options.query_timeout_ms, live)?;
    let state = Arc::new(State {
        data_dir: data_dir.clone(),
        source,
        started_at: iso(now_ms()),
        apps: apps.clone(),
        wal,
        storage,
        queries,
        limiter: Mutex::new(RateLimiter::new(
            options.limits.clone(),
            options.max_clients,
        )),
        batch_limit: max_batch(&options.limits),
        verifier: Mutex::new(TokenVerifier::new(&options.key)),
        public_flight: InFlight::new(options.max_requests, options.max_client_requests),
        admin_flight: InFlight::new(options.max_requests, options.max_client_requests),
        ip_header: options.ip_header.clone(),
        trusted: trusted.clone(),
        country_header: options.country_header.clone(),
        collect_timeout: Duration::from_millis(options.collect_timeout_ms),
        restore_idle_ms: options.restore_idle_ms,
        seal_delay_ms: options.seal_delay_ms,
        upload_dir,
    });
    let cleanup = |state: Arc<State>| {
        state.queries.close();
        state.storage.stop();
        state.wal.close_shared();
    };
    let tls: Option<TlsConfig> = match (&options.tls_cert, &options.tls_key) {
        (Some(cert), Some(key)) => match load_tls(cert, key) {
            Ok(config) => Some(Arc::new(RwLock::new(Arc::new(config)))),
            Err(error) => {
                cleanup(state);
                return Err(error);
            }
        },
        _ => None,
    };
    let public = bind(options.port, options.hostname.as_deref()).await;
    let admin_host = options.admin_hostname.clone().or(options.hostname.clone());
    let admin = match &public {
        Ok(_) => bind(options.admin_port, admin_host.as_deref()).await,
        Err(_) => Err(Error::new("")),
    };
    let (public, admin) = match (public, admin) {
        (Ok(public), Ok(admin)) => (public, admin),
        (Err(error), _) | (_, Err(error)) => {
            cleanup(state);
            return Err(error);
        }
    };
    let address = |listener: &TcpListener| -> SocketAddr {
        listener
            .local_addr()
            .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 0)))
    };
    let public_address = address(&public);
    let admin_address = address(&admin);
    let ip_header = options.ip_header.clone();
    let limited: crate::http::LimitedPeer = Arc::new(move |peer: &IpAddr| {
        ip_header.is_none() || !is_trusted(&peer.to_string(), &trusted)
    });
    let limits = options
        .http
        .clone()
        .unwrap_or_else(|| Limits::with_connections(options.max_connections));
    let (shutdown, receiver) = watch::channel(false);
    let mut serving = Vec::new();
    for (listener, port) in [(public, Port::Public), (admin, Port::Admin)] {
        let handler: Arc<dyn Handler> = Arc::new(PortHandler {
            state: state.clone(),
            port,
        });
        let config = Listener::new(limits.clone(), tls.clone(), limited.clone());
        serving.push(tokio::spawn(serve(
            listener,
            config,
            handler,
            receiver.clone(),
        )));
    }
    let mut background = Vec::new();
    let refresh_apps = apps.clone();
    let refresh_every = Duration::from_millis(options.build_refresh_ms.max(1));
    background.push(tokio::spawn(async move {
        let mut interval = tokio::time::interval(refresh_every);
        interval.tick().await;
        loop {
            interval.tick().await;
            let apps = refresh_apps.clone();
            let refreshed = tokio::task::spawn_blocking(move || apps.refresh_all()).await;
            if let Ok(Err(error)) = refreshed {
                logger::error(format!("The refresh of the build file failed: {error}"));
            }
        }
    }));
    let watcher = match (&options.tls_cert, &options.tls_key, &tls) {
        (Some(cert), Some(key), Some(config)) => {
            let paths = options
                .tls_watch
                .clone()
                .unwrap_or_else(|| vec![cert.clone(), key.clone()]);
            let on_change: OnTlsChange = match &options.on_tls_change {
                Some(on_change) => on_change.clone(),
                None => {
                    let (cert, key, config) = (cert.clone(), key.clone(), config.clone());
                    Arc::new(move || match load_tls(&cert, &key) {
                        Ok(fresh) => {
                            *config.write().unwrap_or_else(|poison| poison.into_inner()) =
                                Arc::new(fresh);
                            logger::info(
                                "The TLS certificate changed, the server uses the new one",
                            );
                            true
                        }
                        Err(error) => {
                            logger::error(format!(
                                "The new TLS certificate does not work, the server keeps the old one: {error}"
                            ));
                            false
                        }
                    })
                }
            };
            Some(watch_files(
                paths,
                Duration::from_millis(options.tls_check_ms.max(1)),
                on_change,
            ))
        }
        _ => None,
    };
    Ok(RunningServer {
        port: public_address.port(),
        hostname: public_address.ip().to_string(),
        admin_port: admin_address.port(),
        admin_hostname: admin_address.ip().to_string(),
        state,
        shutdown,
        serving,
        background,
        watcher,
        lock: Some(lock),
    })
}
