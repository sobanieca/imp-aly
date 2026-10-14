#![allow(dead_code)]

use imp_aly::app_build::FetchFile;
use imp_aly::json::{self, Value};
use imp_aly::server::{RunningServer, ServerOptions, start_server};
use imp_aly::testing::TempDir;
use imp_aly::token::{EMPTY_BODY_HASH, create_token, sha256_hex};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;

pub const KEY: &str = "test-key-0123456789";

pub const PAGES: [&str; 3] = ["/", "/invoices", "/invoices/:id"];

pub const BUILD_URL: &str = "https://myapp.example/app-analytics.json";

pub const APP_URL: &str = "https://myapp.example/";

pub fn build_text(pages: Option<&str>, zones: Option<&str>, outcomes: Option<&str>) -> String {
    format!(
        r#"{{"pages":{},"zones":{},"outcomes":{}}}"#,
        pages.unwrap_or(r#"["/","/invoices","/invoices/:id"]"#),
        zones.unwrap_or(r#"["myapp.list","myapp.send"]"#),
        outcomes.unwrap_or(r#"["myapp.sent"]"#)
    )
}

pub fn build_body() -> String {
    format!(
        r#"{{"build":{}}}"#,
        json::quote(&build_text(None, None, None))
    )
}

pub fn now() -> i64 {
    imp_aly::days::now_ms()
}

pub fn record(fields: &str) -> String {
    format!(
        r#"{{"visit":"k3v9a1c2","at":{},"page":"/invoices/:id",{fields}}}"#,
        now()
    )
}

pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub text: String,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn get(&self, path: &str) -> Value {
        let mut value = self.body.clone();
        for key in path.split('.') {
            value = match key.parse::<usize>() {
                Ok(index) => value
                    .as_array()
                    .and_then(|items| items.get(index))
                    .cloned()
                    .unwrap_or(Value::Null),
                Err(_) => value.get(key).cloned().unwrap_or(Value::Null),
            };
        }
        value
    }

    pub fn text_of(&self, path: &str) -> String {
        json::stringify(&self.get(path))
    }
}

pub fn parse_response(bytes: &[u8]) -> Answer {
    let end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap_or(bytes.len());
    let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let raw = if end + 4 <= bytes.len() {
        &bytes[end + 4..]
    } else {
        &[][..]
    };
    let chunked = headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value == "chunked");
    let body_bytes = if chunked { dechunk(raw) } else { raw.to_vec() };
    let text = String::from_utf8_lossy(&body_bytes).into_owned();
    let body = json::parse(&text).unwrap_or(Value::Null);
    Answer {
        status,
        headers,
        body,
        text,
    }
}

pub fn dechunk(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = raw.windows(2).position(|pair| pair == b"\r\n") else {
            return out;
        };
        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..line_end]).trim(), 16)
            .unwrap_or(0);
        if size == 0 {
            return out;
        }
        let start = line_end + 2;
        out.extend_from_slice(&raw[start..(start + size).min(raw.len())]);
        raw = &raw[(start + size + 2).min(raw.len())..];
    }
}

pub fn raw_bytes(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    headers: &[(&str, &str)],
) -> Vec<u8> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut request =
        format!("{method} {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        request.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    let mut bytes = request.into_bytes();
    if let Some(body) = body {
        bytes.extend_from_slice(body);
    }
    stream.write_all(&bytes).unwrap();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    response
}

pub fn send(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> Answer {
    parse_response(&raw_bytes(
        port,
        method,
        path,
        body.map(str::as_bytes),
        headers,
    ))
}

pub fn token(key: &str, method: &str, path: &str, body: Option<&[u8]>) -> String {
    let hash = body.map_or(EMPTY_BODY_HASH.to_string(), sha256_hex);
    create_token(key, method, path, &hash)
}

pub struct Server {
    pub runtime: Runtime,
    pub server: Option<RunningServer>,
    pub port: u16,
    pub admin_port: u16,
    pub data_dir: String,
    pub dir: Option<TempDir>,
    pub files: Arc<Mutex<HashMap<String, String>>>,
    pub fetched: Arc<Mutex<Vec<String>>>,
}

pub fn hosted() -> HashMap<String, String> {
    HashMap::from([(BUILD_URL.to_string(), build_text(None, None, None))])
}

pub fn options(data_dir: &str) -> ServerOptions {
    let mut options = ServerOptions::new(data_dir, KEY);
    options.port = 0;
    options.admin_port = 0;
    options.hostname = Some("127.0.0.1".to_string());
    options.min_free = None;
    options.segment_ms = 30;
    options
}

impl Server {
    pub fn start(configure: impl FnOnce(&mut ServerOptions)) -> Server {
        Server::start_in(None, configure)
    }

    pub fn start_in(
        data_dir: Option<String>,
        configure: impl FnOnce(&mut ServerOptions),
    ) -> Server {
        imp_aly::logger::set_quiet(true);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        let (dir, data_dir) = match data_dir {
            Some(path) => (None, path),
            None => {
                let dir = TempDir::new();
                let path = dir.path.clone();
                (Some(dir), path)
            }
        };
        let files = Arc::new(Mutex::new(hosted()));
        let fetched = Arc::new(Mutex::new(Vec::new()));
        let mut options = options(&data_dir);
        let (served, seen) = (files.clone(), fetched.clone());
        let fetch: FetchFile = Arc::new(move |url: &str| {
            seen.lock().unwrap().push(url.to_string());
            served
                .lock()
                .unwrap()
                .get(url)
                .cloned()
                .ok_or_else(|| format!("GET {url} answered 404"))
        });
        options.fetch_file = Some(fetch);
        configure(&mut options);
        let server = runtime
            .block_on(start_server(options))
            .expect("the server starts");
        Server {
            port: server.port,
            admin_port: server.admin_port,
            runtime,
            server: Some(server),
            data_dir,
            dir,
            files,
            fetched,
        }
    }

    pub fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Answer {
        send(self.port, method, path, body, headers)
    }

    pub fn admin(&self, method: &str, path: &str, body: Option<&str>) -> Answer {
        let token = token(KEY, method, path, body.map(str::as_bytes));
        let auth = format!("Bearer {token}");
        send(
            self.admin_port,
            method,
            path,
            body,
            &[("authorization", &auth)],
        )
    }

    pub fn admin_signed(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
        signed_method: &str,
        signed_path: &str,
        signed_body: Option<&str>,
    ) -> Answer {
        let token = token(
            KEY,
            signed_method,
            signed_path,
            signed_body.map(str::as_bytes),
        );
        let auth = format!("Bearer {token}");
        send(
            self.admin_port,
            method,
            path,
            body,
            &[("authorization", &auth)],
        )
    }

    pub fn register(&self) {
        assert_eq!(
            self.admin("PUT", "/apps/myapp", Some(&build_body())).status,
            200
        );
    }

    pub fn wait_for(&self, mut check: impl FnMut() -> bool) {
        let start = Instant::now();
        while !check() {
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "the condition did not happen in time"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    pub fn matched(&self, query: &str) -> u64 {
        self.admin("POST", "/query", Some(query))
            .get("matched")
            .as_f64()
            .unwrap_or(0.0) as u64
    }

    pub fn stop(mut self) -> String {
        if let Some(server) = self.server.take() {
            self.runtime.block_on(server.shutdown());
        }
        match self.dir.take() {
            Some(dir) => dir.keep(),
            None => self.data_dir.clone(),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            self.runtime.block_on(server.shutdown());
        }
    }
}

pub const DAYS: [&str; 2] = ["2026-09-20", "2026-09-21"];

pub const SOURCE: &str = "0123456789abcdef";

pub const OTHER_SOURCE: &str = "fedcba9876543210";

pub fn day_path(data_dir: &str, day: &str, source: &str) -> String {
    format!("{data_dir}/apps/myapp/{day}/{source}")
}

pub fn seal_all(data_dir: &str, source: &str, days: &[String]) {
    for day in days {
        imp_aly::column_store::seal_day(&day_path(data_dir, day, source)).unwrap();
    }
}

pub fn fill_text(days: &[String], keep: &dyn Fn(u64) -> bool) -> String {
    let mut text = String::new();
    let mut seed = 7.0f64;
    let mut next = |n: f64| {
        seed = (seed * 1_103_515_245.0 + 12_345.0) % 2_147_483_648.0;
        (seed % n) as usize
    };
    let types = ["page", "seen", "used", "used", "outcome", "error"];
    for day in days {
        let start = imp_aly::days::day_ms(day).unwrap();
        for visit in 0..40u64 {
            let number = visit % 30;
            let kept = keep(number);
            let plan = if visit % 3 == 0 {
                None
            } else {
                Some(["pro", "free"][(visit % 2) as usize])
            };
            for step in 0..12u64 {
                let kind = types[next(6.0)];
                let mut record = imp_aly::json::Object::new()
                    .with("type", kind)
                    .with("visit", format!("v{number}"))
                    .with("at", start + (visit * 1000 + step) as i64)
                    .with("page", PAGES[next(3.0)])
                    .with("country", if visit % 4 != 0 { "PL" } else { "DE" });
                if let Some(plan) = plan {
                    record.insert("plan", plan);
                }
                if kind == "seen" || (kind == "used" && next(2.0) != 0) {
                    record.insert("zone", format!("myapp.zone-{}", next(4.0)));
                }
                if kind == "outcome" {
                    record.insert("name", format!("myapp.done-{}", next(2.0)));
                }
                if kept {
                    let line = Value::Array(vec![
                        Value::from("myapp"),
                        Value::from(day.as_str()),
                        Value::Object(record),
                    ]);
                    text.push_str(&json::stringify(&line));
                    text.push('\n');
                }
            }
        }
    }
    text
}

pub fn fill_into(data_dir: &str, days: &[String], source: &str, keep: &dyn Fn(u64) -> bool) {
    imp_aly::logger::set_quiet(true);
    imp_aly::storage::apply_segment_text(data_dir, source, 1, &fill_text(days, keep)).unwrap();
}

pub fn fill(days: &[String], source: &str, keep: &dyn Fn(u64) -> bool) -> TempDir {
    let dir = TempDir::new();
    fill_into(&dir.path, days, source, keep);
    dir
}

pub fn days(list: &[&str]) -> Vec<String> {
    imp_aly::logger::set_quiet(true);
    list.iter().map(|day| day.to_string()).collect()
}

pub fn all(_: u64) -> bool {
    true
}

pub fn ask(data_dir: &str, query: &imp_aly::query_core::Query) -> Value {
    let answer = imp_aly::query::run_query(data_dir, query, &|| false).unwrap();
    let answer = json::parse(&json::stringify(&answer)).unwrap();
    Value::Object(imp_aly::query_core::finalize_query(
        query,
        &[imp_aly::query_core::ServerAnswer {
            server: "local".to_string(),
            answer,
        }],
    ))
}

pub fn answer_of(data_dir: &str, query: &imp_aly::query_core::Query) -> Value {
    let answer = imp_aly::query::run_query(data_dir, query, &|| false).unwrap();
    json::parse(&json::stringify(&answer)).unwrap()
}
