use crate::error::{Error, Result};
use crate::http::{BoxFuture, Handler, Limits, Listener, Request, Response, serve};
use crate::static_files::{Files, serve_ui};
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub const DEFAULT_CONSOLE_PORT: u16 = 8010;

const SECURITY_HEADERS: [(&str, &str); 6] = [
    (
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https: http:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ),
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
];

pub fn console_hosts(port: u16) -> HashSet<String> {
    [
        format!("localhost:{port}"),
        format!("127.0.0.1:{port}"),
        format!("[::1]:{port}"),
    ]
    .into_iter()
    .collect()
}

struct ConsoleHandler {
    files: Files,
    hosts: Arc<RwLock<HashSet<String>>>,
}

impl ConsoleHandler {
    fn respond(&self, request: &Request) -> Response {
        let host = request.header("host").unwrap_or("");
        let allowed = self
            .hosts
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .contains(host);
        let mut response = if !allowed {
            Response::text(
                403,
                "the console answers only on localhost\n",
                "text/plain; charset=utf-8",
            )
        } else if request.method != "GET" && request.method != "HEAD" {
            Response::text(
                405,
                "the console serves files only\n",
                "text/plain; charset=utf-8",
            )
        } else {
            serve_ui(&self.files, &request.path)
        };
        for (name, value) in SECURITY_HEADERS {
            response.set_header(name, value);
        }
        response
    }
}

impl Handler for ConsoleHandler {
    fn handle<'a>(&'a self, request: &'a mut Request) -> BoxFuture<'a, Response> {
        Box::pin(async move { self.respond(request) })
    }
}

pub struct RunningConsole {
    pub port: u16,
    pub url: String,
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl RunningConsole {
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            let _ = task.await;
        }
    }
}

pub async fn start_console(port: u16, files: Files) -> Result<RunningConsole> {
    if !files.is_built() {
        return Err(Error::new(format!(
            "the console page is missing in {} - build it with: cargo console-build",
            files.describe()
        )));
    }
    let main = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                Error::new(format!(
                    "the port {port} is in use - choose another one with --port"
                ))
            } else {
                Error::new(format!("cannot listen on 127.0.0.1 port {port}: {error}"))
            }
        })?;
    let bound = main
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(port);
    let hosts = Arc::new(RwLock::new(console_hosts(bound)));
    let handler: Arc<dyn Handler> = Arc::new(ConsoleHandler { files, hosts });
    let limited = Arc::new(|_: &IpAddr| false);
    let config = Listener::new(Limits::with_connections(256), None, limited);
    let (shutdown, receiver) = watch::channel(false);
    let mut tasks = vec![tokio::spawn(serve(
        main,
        config.clone(),
        handler.clone(),
        receiver.clone(),
    ))];
    if let Ok(second) = TcpListener::bind(("::1", bound)).await {
        tasks.push(tokio::spawn(serve(second, config, handler, receiver)));
    }
    Ok(RunningConsole {
        port: bound,
        url: format!("http://localhost:{bound}"),
        shutdown,
        tasks,
    })
}
