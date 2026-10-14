use crate::json::{Object, Value, stringify};
use crate::logger;
use crate::rate_limit::client_keys;
use crate::url::request_target;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep, timeout, timeout_at};

#[derive(Clone, Debug)]
pub struct Limits {
    pub max_connections: usize,
    pub max_client_connections: usize,
    pub head_timeout: Duration,
    pub idle_timeout: Duration,
    pub busy_idle_timeout: Duration,
    pub handshake_timeout: Duration,
    pub write_timeout: Duration,
    pub linger_timeout: Duration,
    pub max_head_bytes: usize,
    pub max_headers: usize,
    pub max_requests_per_connection: usize,
    pub drain_timeout: Duration,
}

pub const DEFAULT_MAX_CONNECTIONS: usize = 4_096;

pub const CONNECTION_SHARE: usize = 32;

pub const NETWORK_CONNECTION_SHARE: usize = 4;

impl Default for Limits {
    fn default() -> Self {
        Limits::with_connections(DEFAULT_MAX_CONNECTIONS)
    }
}

impl Limits {
    pub fn with_connections(max_connections: usize) -> Self {
        Limits {
            max_connections,
            max_client_connections: (max_connections / CONNECTION_SHARE).max(1),
            head_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(5),
            busy_idle_timeout: Duration::from_secs(1),
            handshake_timeout: Duration::from_secs(10),
            write_timeout: Duration::from_secs(30),
            linger_timeout: Duration::from_secs(2),
            max_head_bytes: 16_384,
            max_headers: 64,
            max_requests_per_connection: 1_000,
            drain_timeout: Duration::from_secs(10),
        }
    }
}

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
}

impl HttpError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        HttpError {
            status,
            message: message.into(),
        }
    }
}

enum BodyState {
    Length(u64),
    Chunked(ChunkState),
    Done,
}

#[derive(Clone, Copy)]
enum ChunkState {
    Size,
    Data(u64),
    DataEnd,
    Trailers,
}

const MAX_CHUNK_LINE: usize = 4_096;

const MAX_TRAILER_BYTES: usize = 16_384;

pub struct Body {
    io: Option<Box<dyn Io>>,
    buffer: Vec<u8>,
    start: usize,
    state: BodyState,
    declared: Option<u64>,
    continue_pending: bool,
    broken: bool,
    trailer_bytes: usize,
}

impl Body {
    fn empty() -> Body {
        Body {
            io: None,
            buffer: Vec::new(),
            start: 0,
            state: BodyState::Done,
            declared: Some(0),
            continue_pending: false,
            broken: false,
            trailer_bytes: 0,
        }
    }

    pub fn declared_length(&self) -> Option<u64> {
        self.declared
    }

    pub fn is_complete(&self) -> bool {
        matches!(self.state, BodyState::Done) && !self.broken
    }

    pub fn has_body(&self) -> bool {
        !matches!(self.state, BodyState::Done) || self.declared.is_some_and(|length| length > 0)
    }

    fn buffered(&self) -> &[u8] {
        &self.buffer[self.start..]
    }

    async fn fill(&mut self) -> Result<usize, HttpError> {
        if self.continue_pending {
            self.continue_pending = false;
            let io = self.io.as_mut().ok_or_else(read_error)?;
            io.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .await
                .map_err(|_| read_error())?;
            io.flush().await.map_err(|_| read_error())?;
        }
        if self.start > 0 && self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        }
        let io = self.io.as_mut().ok_or_else(read_error)?;
        let mut chunk = [0u8; 16_384];
        let size = io.read(&mut chunk).await.map_err(|_| read_error())?;
        if size == 0 {
            return Err(read_error());
        }
        self.buffer.extend_from_slice(&chunk[..size]);
        Ok(size)
    }

    fn take(&mut self, count: usize) -> Vec<u8> {
        let bytes = self.buffer[self.start..self.start + count].to_vec();
        self.start += count;
        bytes
    }

    fn take_line(&mut self) -> Result<Option<Vec<u8>>, HttpError> {
        let buffered = self.buffered();
        match buffered.windows(2).position(|pair| pair == b"\r\n") {
            Some(at) => {
                let line = buffered[..at].to_vec();
                self.start += at + 2;
                Ok(Some(line))
            }
            None if buffered.len() > MAX_CHUNK_LINE => Err(HttpError::new(
                400,
                "the body has a chunk line that is too long",
            )),
            None => Ok(None),
        }
    }

    async fn next_inner(&mut self) -> Result<Option<Vec<u8>>, HttpError> {
        loop {
            match self.state {
                BodyState::Done => return Ok(None),
                BodyState::Length(0) => {
                    self.state = BodyState::Done;
                    return Ok(None);
                }
                BodyState::Length(left) => {
                    if self.buffered().is_empty() {
                        self.fill().await?;
                    }
                    let count = (self.buffered().len() as u64).min(left) as usize;
                    let bytes = self.take(count);
                    self.state = BodyState::Length(left - count as u64);
                    if left - count as u64 == 0 {
                        self.state = BodyState::Done;
                    }
                    return Ok(Some(bytes));
                }
                BodyState::Chunked(ChunkState::Size) => match self.take_line()? {
                    None => {
                        self.fill().await?;
                    }
                    Some(line) => {
                        let text = String::from_utf8_lossy(&line);
                        let size_text = text.split(';').next().unwrap_or("").trim();
                        if size_text.is_empty()
                            || size_text.len() > 15
                            || !size_text.bytes().all(|byte| byte.is_ascii_hexdigit())
                        {
                            return Err(HttpError::new(400, "the body has a wrong chunk size"));
                        }
                        let size = u64::from_str_radix(size_text, 16).unwrap_or(0);
                        self.state = if size == 0 {
                            BodyState::Chunked(ChunkState::Trailers)
                        } else {
                            BodyState::Chunked(ChunkState::Data(size))
                        };
                    }
                },
                BodyState::Chunked(ChunkState::Data(left)) => {
                    if self.buffered().is_empty() {
                        self.fill().await?;
                    }
                    let count = (self.buffered().len() as u64).min(left) as usize;
                    let bytes = self.take(count);
                    let rest = left - count as u64;
                    self.state = BodyState::Chunked(if rest == 0 {
                        ChunkState::DataEnd
                    } else {
                        ChunkState::Data(rest)
                    });
                    return Ok(Some(bytes));
                }
                BodyState::Chunked(ChunkState::DataEnd) => {
                    if self.buffered().len() < 2 {
                        self.fill().await?;
                        continue;
                    }
                    if &self.buffered()[..2] != b"\r\n" {
                        return Err(HttpError::new(
                            400,
                            "the body has a chunk without its line break",
                        ));
                    }
                    self.start += 2;
                    self.state = BodyState::Chunked(ChunkState::Size);
                }
                BodyState::Chunked(ChunkState::Trailers) => match self.take_line()? {
                    None => {
                        self.fill().await?;
                    }
                    Some(line) => {
                        self.trailer_bytes += line.len() + 2;
                        if self.trailer_bytes > MAX_TRAILER_BYTES {
                            return Err(HttpError::new(431, "the body has too many trailers"));
                        }
                        if line.is_empty() {
                            self.state = BodyState::Done;
                            return Ok(None);
                        }
                    }
                },
            }
        }
    }

    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, HttpError> {
        if self.broken {
            return Err(read_error());
        }
        match self.next_inner().await {
            Ok(chunk) => Ok(chunk),
            Err(error) => {
                self.broken = true;
                Err(error)
            }
        }
    }

    pub async fn next_chunk_within(
        &mut self,
        idle: Duration,
    ) -> Result<Option<Vec<u8>>, HttpError> {
        match timeout(idle, self.next_chunk()).await {
            Ok(result) => result,
            Err(_) => {
                self.broken = true;
                Err(HttpError::new(408, "timeout"))
            }
        }
    }

    pub async fn read_all(
        &mut self,
        max_bytes: usize,
        limit: Duration,
    ) -> Result<Vec<u8>, HttpError> {
        if self
            .declared
            .is_some_and(|length| length > max_bytes as u64)
        {
            self.broken = true;
            return Err(too_large(max_bytes));
        }
        let deadline = Instant::now() + limit;
        let mut bytes = Vec::new();
        loop {
            let chunk = match timeout_at(deadline, self.next_chunk()).await {
                Ok(chunk) => chunk?,
                Err(_) => {
                    self.broken = true;
                    return Err(HttpError::new(408, "the body did not arrive in time"));
                }
            };
            let Some(chunk) = chunk else {
                return Ok(bytes);
            };
            if bytes.len() + chunk.len() > max_bytes {
                self.broken = true;
                return Err(too_large(max_bytes));
            }
            bytes.extend_from_slice(&chunk);
        }
    }
}

fn read_error() -> HttpError {
    HttpError::new(400, "the body could not be read")
}

fn too_large(max_bytes: usize) -> HttpError {
    HttpError::new(413, format!("the body is larger than {max_bytes} bytes"))
}

pub struct Request {
    pub method: String,
    pub target: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub peer: IpAddr,
    pub body: Body,
    http10: bool,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn has_header(&self, name: &str) -> bool {
        self.headers.iter().any(|(key, _)| key == name)
    }
}

pub enum ResponseBody {
    Empty,
    Bytes(Vec<u8>),
    Stream(mpsc::Receiver<io::Result<Vec<u8>>>),
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: ResponseBody,
    pub close: bool,
}

impl Response {
    pub fn new(status: u16) -> Self {
        Response {
            status,
            headers: Vec::new(),
            body: ResponseBody::Empty,
            close: false,
        }
    }

    pub fn json(status: u16, value: &Value) -> Self {
        Response::new(status)
            .header("content-type", "application/json")
            .bytes(stringify(value).into_bytes())
    }

    pub fn error(status: u16, message: &str) -> Self {
        Response::json(status, &Object::new().with("error", message).into())
    }

    pub fn text(status: u16, text: &str, content_type: &str) -> Self {
        Response::new(status)
            .header("content-type", content_type)
            .bytes(text.as_bytes().to_vec())
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.set_header(name, value);
        self
    }

    pub fn set_header(&mut self, name: &str, value: &str) {
        match self.headers.iter_mut().find(|(key, _)| key == name) {
            Some(entry) => entry.1 = value.to_string(),
            None => self.headers.push((name.to_string(), value.to_string())),
        }
    }

    pub fn get_header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn bytes(mut self, bytes: Vec<u8>) -> Self {
        self.body = ResponseBody::Bytes(bytes);
        self
    }

    pub fn stream(mut self, receiver: mpsc::Receiver<io::Result<Vec<u8>>>) -> Self {
        self.body = ResponseBody::Stream(receiver);
        self
    }
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Handler: Send + Sync + 'static {
    fn handle<'a>(&'a self, request: &'a mut Request) -> BoxFuture<'a, Response>;
}

struct GateState {
    count: usize,
    by_key: HashMap<String, usize>,
}

pub struct Gate {
    max: usize,
    per_client: usize,
    state: Mutex<GateState>,
}

pub struct GateTicket {
    gate: Arc<Gate>,
    keys: Vec<String>,
}

impl Drop for GateTicket {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.count = state.count.saturating_sub(1);
        for key in &self.keys {
            let left = state
                .by_key
                .get(key)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if left == 0 {
                state.by_key.remove(key);
            } else {
                state.by_key.insert(key.clone(), left);
            }
        }
    }
}

impl Gate {
    pub fn new(max: usize, per_client: usize) -> Arc<Gate> {
        Arc::new(Gate {
            max,
            per_client,
            state: Mutex::new(GateState {
                count: 0,
                by_key: HashMap::new(),
            }),
        })
    }

    pub fn count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .count
    }

    pub fn busy(&self) -> bool {
        self.count() * 2 >= self.max
    }

    pub fn enter(self: &Arc<Self>, peer: &IpAddr, limited: bool) -> Option<GateTicket> {
        let keys: Vec<(String, usize)> = if limited {
            client_keys(&peer.to_canonical().to_string())
                .into_iter()
                .map(|client| {
                    let limit = if client.scale > 1 {
                        self.per_client * NETWORK_CONNECTION_SHARE
                    } else {
                        self.per_client
                    };
                    (client.key, limit)
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.count >= self.max {
            return None;
        }
        if keys
            .iter()
            .any(|(key, limit)| state.by_key.get(key).copied().unwrap_or(0) >= *limit)
        {
            return None;
        }
        state.count += 1;
        for (key, _) in &keys {
            *state.by_key.entry(key.clone()).or_insert(0) += 1;
        }
        Some(GateTicket {
            gate: self.clone(),
            keys: keys.into_iter().map(|(key, _)| key).collect(),
        })
    }
}

pub type TlsConfig = Arc<RwLock<Arc<rustls::ServerConfig>>>;

pub type LimitedPeer = Arc<dyn Fn(&IpAddr) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct Listener {
    pub limits: Limits,
    pub tls: Option<TlsConfig>,
    pub limited: LimitedPeer,
    pub gate: Arc<Gate>,
}

impl Listener {
    pub fn new(limits: Limits, tls: Option<TlsConfig>, limited: LimitedPeer) -> Listener {
        let gate = Gate::new(limits.max_connections, limits.max_client_connections);
        Listener {
            limits,
            tls,
            limited,
            gate,
        }
    }
}

pub fn spawn_serve(
    listener: TcpListener,
    config: Listener,
    handler: Arc<dyn Handler>,
    shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(serve(listener, config, handler, shutdown))
}

pub async fn serve(
    listener: TcpListener,
    config: Listener,
    handler: Arc<dyn Handler>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut connections = JoinSet::new();
    let active = Arc::new(AtomicUsize::new(0));
    loop {
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let limited = (config.limited)(&peer.ip().to_canonical());
                    let Some(ticket) = config.gate.enter(&peer.ip(), limited) else {
                        logger::debug(format!("Refused a connection of {}: too many connections", peer.ip()));
                        drop(stream);
                        continue;
                    };
                    let config = config.clone();
                    let handler = handler.clone();
                    let shutdown = shutdown.clone();
                    let active = active.clone();
                    active.fetch_add(1, Ordering::Relaxed);
                    connections.spawn(async move {
                        connection(stream, peer, config, handler, shutdown).await;
                        drop(ticket);
                        active.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Err(error) => {
                    logger::debug(format!("Cannot accept a connection: {error}"));
                    sleep(Duration::from_millis(50)).await;
                }
            }
        }
    }
    drop(listener);
    let drained = timeout(config.limits.drain_timeout, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
}

async fn connection(
    stream: TcpStream,
    peer: SocketAddr,
    config: Listener,
    handler: Arc<dyn Handler>,
    shutdown: watch::Receiver<bool>,
) {
    let _ = stream.set_nodelay(true);
    let io: Box<dyn Io> = match &config.tls {
        None => Box::new(stream),
        Some(tls) => {
            let server_config = tls
                .read()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone();
            let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
            match timeout(config.limits.handshake_timeout, acceptor.accept(stream)).await {
                Ok(Ok(stream)) => Box::new(stream),
                _ => return,
            }
        }
    };
    serve_connection(
        io,
        peer.ip().to_canonical(),
        &config,
        handler.as_ref(),
        shutdown,
    )
    .await;
}

enum Head {
    Request(Box<ParsedHead>),
    Closed,
    Failed(u16, String),
}

struct ParsedHead {
    method: String,
    raw_target: String,
    http10: bool,
    headers: Vec<(String, String)>,
    length: Option<u64>,
    chunked: bool,
    expect_continue: bool,
    close: bool,
}

fn find_head_end(buffer: &[u8], from: usize) -> Option<usize> {
    let start = from.saturating_sub(3);
    buffer[start..]
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| start + at)
}

fn is_token(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

fn parse_head(bytes: &[u8], limits: &Limits) -> Result<ParsedHead, (u16, String)> {
    let bad = |message: &str| (400, message.to_string());
    let text = std::str::from_utf8(bytes).map_err(|_| bad("the request head is not valid text"))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let parts: Vec<&str> = request_line.split(' ').collect();
    if parts.len() != 3 {
        return Err(bad("the request line is not valid"));
    }
    let (method, raw_target, version) = (parts[0], parts[1], parts[2]);
    if method.is_empty()
        || method.len() > 16
        || !method.bytes().all(|byte| byte.is_ascii_uppercase())
    {
        return Err(bad("the request method is not valid"));
    }
    let http10 = match version {
        "HTTP/1.1" => false,
        "HTTP/1.0" => true,
        _ if version.starts_with("HTTP/") => {
            return Err((505, "the server speaks HTTP/1.1".to_string()));
        }
        _ => return Err(bad("the request line is not valid")),
    };
    if !(raw_target.starts_with('/') || (raw_target == "*" && method == "OPTIONS"))
        || raw_target.bytes().any(|byte| byte <= b' ' || byte == 0x7f)
    {
        return Err(bad("the request target is not valid"));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(bad("the request has a folded header"));
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(bad("the request has a header that is not valid"));
        };
        if !is_token(name) {
            return Err(bad("the request has a header name that is not valid"));
        }
        let value = value.trim_matches([' ', '\t']);
        if value
            .bytes()
            .any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
        {
            return Err(bad("the request has a header value that is not valid"));
        }
        headers.push((name.to_ascii_lowercase(), value.to_string()));
        if headers.len() > limits.max_headers {
            return Err((431, "the request has too many headers".to_string()));
        }
    }
    let mut length: Option<u64> = None;
    for (_, value) in headers.iter().filter(|(name, _)| name == "content-length") {
        if value.is_empty() || value.len() > 19 || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(bad("the request has a content-length that is not valid"));
        }
        let parsed: u64 = value
            .parse()
            .map_err(|_| bad("the request has a content-length that is not valid"))?;
        if length.is_some_and(|known| known != parsed) {
            return Err(bad("the request has two different content-length headers"));
        }
        length = Some(parsed);
    }
    let encodings: Vec<&str> = headers
        .iter()
        .filter(|(name, _)| name == "transfer-encoding")
        .map(|(_, value)| value.as_str())
        .collect();
    let chunked = match encodings.as_slice() {
        [] => false,
        [value] if value.eq_ignore_ascii_case("chunked") => true,
        _ => {
            return Err((
                501,
                "the server reads only a chunked transfer encoding".to_string(),
            ));
        }
    };
    if chunked && (length.is_some() || http10) {
        return Err(bad(
            "the request has a transfer encoding and a content-length",
        ));
    }
    let connection = headers
        .iter()
        .filter(|(name, _)| name == "connection")
        .map(|(_, value)| value.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(",");
    let close = if http10 {
        !connection
            .split(',')
            .any(|token| token.trim() == "keep-alive")
    } else {
        connection.split(',').any(|token| token.trim() == "close")
    };
    let expect_continue = !http10
        && headers
            .iter()
            .any(|(name, value)| name == "expect" && value.eq_ignore_ascii_case("100-continue"));
    Ok(ParsedHead {
        method: method.to_string(),
        raw_target: raw_target.to_string(),
        http10,
        headers,
        length,
        chunked,
        expect_continue,
        close,
    })
}

async fn read_head(
    io: &mut Box<dyn Io>,
    buffer: &mut Vec<u8>,
    first_byte_wait: Duration,
    head_timeout: Duration,
    limits: &Limits,
    shutdown: &mut watch::Receiver<bool>,
) -> Head {
    let start = Instant::now();
    let head_deadline = start + head_timeout;
    let mut scanned = 0;
    loop {
        if let Some(end) = find_head_end(buffer, scanned) {
            if end > limits.max_head_bytes {
                return Head::Failed(431, "the request head is too large".to_string());
            }
            let head = buffer[..end].to_vec();
            buffer.drain(..end + 4);
            return match parse_head(&head, limits) {
                Ok(parsed) => Head::Request(Box::new(parsed)),
                Err((status, message)) => Head::Failed(status, message),
            };
        }
        scanned = buffer.len();
        if buffer.len() > limits.max_head_bytes {
            return Head::Failed(431, "the request head is too large".to_string());
        }
        let deadline = if buffer.is_empty() {
            (start + first_byte_wait).min(head_deadline)
        } else {
            head_deadline
        };
        let mut chunk = [0u8; 8_192];
        let waiting = buffer.is_empty();
        let read = tokio::select! {
            result = timeout_at(deadline, io.read(&mut chunk)) => result,
            _ = shutdown.changed(), if waiting => return Head::Closed,
        };
        match read {
            Err(_) => {
                return if buffer.is_empty() {
                    Head::Closed
                } else {
                    Head::Failed(408, "the request head did not arrive in time".to_string())
                };
            }
            Ok(Err(_)) | Ok(Ok(0)) => return Head::Closed,
            Ok(Ok(size)) => buffer.extend_from_slice(&chunk[..size]),
        }
    }
}

const SECURITY_HEADERS: [(&str, &str); 2] = [
    ("x-content-type-options", "nosniff"),
    (
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'",
    ),
];

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Content Too Large",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        _ => "Unknown",
    }
}

async fn write_slices(io: &mut Box<dyn Io>, bytes: &[u8], limit: Duration) -> io::Result<()> {
    for slice in bytes.chunks(65_536) {
        match timeout(limit, io.write_all(slice)).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the client reads too slowly",
                ));
            }
        }
    }
    Ok(())
}

async fn write_response(
    io: &mut Box<dyn Io>,
    response: Response,
    head_only: bool,
    close: bool,
    limits: &Limits,
) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        reason(response.status)
    );
    let no_body = response.status == 204 || response.status == 304 || response.status < 200;
    for (name, value) in &response.headers {
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection"
        ) {
            continue;
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    if close {
        head.push_str("connection: close\r\n");
    }
    match response.body {
        ResponseBody::Stream(mut receiver) if !no_body => {
            head.push_str("transfer-encoding: chunked\r\n\r\n");
            write_slices(io, head.as_bytes(), limits.write_timeout).await?;
            if head_only {
                return io.flush().await;
            }
            while let Some(chunk) = receiver.recv().await {
                let chunk = chunk?;
                if chunk.is_empty() {
                    continue;
                }
                let mut framed = format!("{:x}\r\n", chunk.len()).into_bytes();
                framed.extend_from_slice(&chunk);
                framed.extend_from_slice(b"\r\n");
                write_slices(io, &framed, limits.write_timeout).await?;
            }
            write_slices(io, b"0\r\n\r\n", limits.write_timeout).await?;
        }
        body => {
            let bytes = match body {
                ResponseBody::Bytes(bytes) => bytes,
                _ => Vec::new(),
            };
            if !no_body {
                head.push_str(&format!("content-length: {}\r\n", bytes.len()));
            }
            head.push_str("\r\n");
            let mut out = head.into_bytes();
            if !no_body && !head_only {
                out.extend_from_slice(&bytes);
            }
            write_slices(io, &out, limits.write_timeout).await?;
        }
    }
    timeout(limits.write_timeout, io.flush())
        .await
        .unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "flush")))
}

async fn linger(io: &mut Box<dyn Io>, limits: &Limits) {
    let _ = timeout(limits.linger_timeout, io.shutdown()).await;
    let deadline = Instant::now() + limits.linger_timeout;
    let mut discarded = 0usize;
    let mut chunk = [0u8; 8_192];
    while discarded < 1 << 20 {
        match timeout_at(deadline, io.read(&mut chunk)).await {
            Ok(Ok(size)) if size > 0 => discarded += size,
            _ => break,
        }
    }
}

pub fn failure_response(status: u16, message: &str) -> Response {
    let mut response = Response::error(status, message);
    for (name, value) in SECURITY_HEADERS {
        response.set_header(name, value);
    }
    response
}

pub async fn serve_connection(
    mut io: Box<dyn Io>,
    peer: IpAddr,
    config: &Listener,
    handler: &dyn Handler,
    mut shutdown: watch::Receiver<bool>,
) {
    let limits = &config.limits;
    let mut buffer: Vec<u8> = Vec::new();
    let mut served = 0usize;
    loop {
        let wait = if served == 0 {
            limits.head_timeout
        } else if config.gate.busy() {
            limits.busy_idle_timeout
        } else {
            limits.idle_timeout
        };
        let head = read_head(
            &mut io,
            &mut buffer,
            wait,
            limits.head_timeout,
            limits,
            &mut shutdown,
        )
        .await;
        let parsed = match head {
            Head::Closed => return,
            Head::Failed(status, message) => {
                let _ = write_response(
                    &mut io,
                    failure_response(status, &message),
                    false,
                    true,
                    limits,
                )
                .await;
                linger(&mut io, limits).await;
                return;
            }
            Head::Request(parsed) => parsed,
        };
        served += 1;
        let target = request_target(&parsed.raw_target);
        let (path, query) = match target.split_once('?') {
            Some((path, query)) => (path.to_string(), query.to_string()),
            None => (target.clone(), String::new()),
        };
        let state = if parsed.chunked {
            BodyState::Chunked(ChunkState::Size)
        } else {
            match parsed.length {
                Some(length) if length > 0 => BodyState::Length(length),
                _ => BodyState::Done,
            }
        };
        let has_body = !matches!(state, BodyState::Done);
        let mut body = Body::empty();
        body.declared = if parsed.chunked {
            None
        } else {
            Some(parsed.length.unwrap_or(0))
        };
        body.state = state;
        body.continue_pending = has_body && parsed.expect_continue;
        body.buffer = std::mem::take(&mut buffer);
        body.io = Some(io);
        let mut request = Request {
            method: parsed.method.clone(),
            target,
            path,
            query,
            headers: parsed.headers,
            peer,
            body,
            http10: parsed.http10,
        };
        let response = handler.handle(&mut request).await;
        let complete = request.body.is_complete();
        let Some(returned) = request.body.io.take() else {
            return;
        };
        io = returned;
        buffer = std::mem::take(&mut request.body.buffer);
        let start = request.body.start;
        buffer.drain(..start.min(buffer.len()));
        let close = response.close
            || parsed.close
            || request.http10
            || !complete
            || *shutdown.borrow()
            || served >= limits.max_requests_per_connection
            || config.gate.busy();
        let head_only = parsed.method == "HEAD";
        if write_response(&mut io, response, head_only, close, limits)
            .await
            .is_err()
        {
            return;
        }
        if close {
            if !complete {
                linger(&mut io, limits).await;
            } else {
                let _ = timeout(limits.linger_timeout, io.shutdown()).await;
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_request_head_and_refuses_smuggling() {
        let limits = Limits::default();
        let head = parse_head(
            b"POST /collect/myapp HTTP/1.1\r\nHost: a\r\nContent-Length: 12\r\nExpect: 100-continue",
            &limits,
        )
        .unwrap();
        assert_eq!(head.method, "POST");
        assert_eq!(head.length, Some(12));
        assert!(head.expect_continue);
        let status = |text: &[u8]| parse_head(text, &limits).err().map(|(status, _)| status);
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked"),
            Some(400)
        );
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2"),
            Some(400)
        );
        assert_eq!(status(b"POST / HTTP/1.1\r\nContent-Length: +1"), Some(400));
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked"),
            Some(501)
        );
        assert_eq!(status(b"GET / HTTP/1.1\r\nX: a\r\n folded"), Some(400));
        assert_eq!(status(b"GET / HTTP/2.0"), Some(505));
        assert_eq!(status(b"GET http://a/ HTTP/1.1"), Some(400));
        assert_eq!(status(b"get / HTTP/1.1"), Some(400));
        assert_eq!(status(b"GET / HTTP/1.1\r\nBad Name: x"), Some(400));
        let many: String = (0..100).map(|at| format!("\r\nx{at}: y")).collect();
        assert_eq!(
            status(format!("GET / HTTP/1.1{many}").as_bytes()),
            Some(431)
        );
    }

    #[test]
    fn a_gate_holds_a_share_of_the_connections_per_address() {
        let gate = Gate::new(8, 2);
        let a: IpAddr = "203.0.113.1".parse().unwrap();
        let b: IpAddr = "203.0.113.2".parse().unwrap();
        let first = gate.enter(&a, true).unwrap();
        let _second = gate.enter(&a, true).unwrap();
        assert!(gate.enter(&a, true).is_none());
        assert!(gate.enter(&a, false).is_some());
        let _other = gate.enter(&b, true).unwrap();
        drop(first);
        assert!(gate.enter(&a, true).is_some());
        let full = Gate::new(1, 1);
        let _held = full.enter(&a, false).unwrap();
        assert!(full.enter(&b, false).is_none());
    }
}
