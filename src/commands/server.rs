use super::help::DEFAULT_DATA_DIR;
use super::runtime;
use crate::VERSION;
use crate::args::{Parsed, parse_port, parse_positive_integer, require_only_flags};
use crate::auth::{
    NEW_KEY_FILE, default_key_path, find_key, find_or_create_key, read_key_file, take_new_key,
};
use crate::error::{Error, Result};
use crate::http::DEFAULT_MAX_CONNECTIONS;
use crate::logger;
use crate::net::{format_host, local_addresses};
use crate::origins::parse_origins;
use crate::paths::{absolute_path, join};
use crate::rate_limit::{DEFAULT_TRUSTED_PROXIES, Window, default_limits, parse_trusted_proxies};
use crate::retention::{DEFAULT_MIN_FREE, parse_min_free};
use crate::server::{
    DEFAULT_ADMIN_PORT, DEFAULT_MAX_REQUESTS, DEFAULT_PORT, RunningServer, ServerOptions,
    start_server,
};
use crate::service::{
    CREDENTIAL_KEY, CREDENTIAL_TLS_CERT, CREDENTIAL_TLS_KEY, KEY_HANDOVER_DIR, SERVICE_DATA_DIR,
    SERVICE_NAME, UnitOptions, credential_path, ensure_service, is_inside_service, service_blocker,
    uninstall_service,
};
use std::sync::Arc;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::mpsc;

const SERVE_FLAGS: [&str; 22] = [
    "port",
    "admin-port",
    "data",
    "auth",
    "bind",
    "admin-bind",
    "ip-header",
    "trusted-proxy",
    "max-requests",
    "max-connections",
    "country-header",
    "allow-origin",
    "min-free",
    "tls-cert",
    "tls-key",
    "limit-5s",
    "limit-1m",
    "limit-1h",
    "limit-24h",
    "foreground",
    "no-auto-update",
    "uninstall",
];

#[derive(Clone, Debug, PartialEq)]
pub struct ServeOptions {
    pub port: u16,
    pub admin_port: u16,
    pub data_dir: Option<String>,
    pub bind: Option<String>,
    pub admin_bind: Option<String>,
    pub ip_header: Option<String>,
    pub trusted_proxies: Vec<String>,
    pub max_requests: u64,
    pub max_connections: u64,
    pub country_header: Option<String>,
    pub allow_origins: Option<Vec<String>>,
    pub min_free: String,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
    pub limits: Vec<Window>,
}

fn read_header_name(value: Option<&str>, flag: &str) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let valid = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid {
        return Err(Error::new(format!(
            "{flag} \"{value}\" is not a header name"
        )));
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn default_trusted() -> Vec<String> {
    DEFAULT_TRUSTED_PROXIES
        .iter()
        .map(|entry| entry.to_string())
        .collect()
}

pub fn read_serve_options(parsed: &Parsed) -> Result<ServeOptions> {
    let min_free = parsed
        .get("min-free")
        .unwrap_or(DEFAULT_MIN_FREE)
        .to_string();
    parse_min_free(&min_free).map_err(Error::new)?;
    if parsed.has("tls-cert") != parsed.has("tls-key") {
        return Err(Error::new("--tls-cert and --tls-key go together"));
    }
    if parsed.has("trusted-proxy") && !parsed.has("ip-header") {
        return Err(Error::new("--trusted-proxy works only with --ip-header"));
    }
    let port = parsed
        .get("port")
        .map(parse_port)
        .transpose()?
        .unwrap_or(DEFAULT_PORT);
    let admin_port = parsed
        .get("admin-port")
        .map(parse_port)
        .transpose()?
        .unwrap_or(DEFAULT_ADMIN_PORT);
    if port == admin_port {
        return Err(Error::new(format!(
            "--port and --admin-port must be different (both are {port})"
        )));
    }
    let trusted_proxies = match parsed.get("trusted-proxy") {
        None => default_trusted(),
        Some(value) => {
            let list = split_list(value);
            if list.is_empty() {
                return Err(Error::new(
                    "--trusted-proxy needs at least one address or network",
                ));
            }
            parse_trusted_proxies(&list)
                .map_err(|error| Error::new(format!("--trusted-proxy: {error}")))?;
            list
        }
    };
    let allow_origins = match parsed.get("allow-origin") {
        None => None,
        Some(value) => {
            let list = split_list(value);
            if list.is_empty() {
                return Err(Error::new("--allow-origin needs at least one origin"));
            }
            Some(
                parse_origins(&list)
                    .map_err(|error| Error::new(format!("--allow-origin: {error}")))?,
            )
        }
    };
    let mut limits = Vec::new();
    for window in default_limits() {
        let flag = format!("limit-{}", window.name);
        let limit = match parsed.get(&flag) {
            None => window.limit,
            Some(value) => parse_positive_integer(value, &format!("--{flag}"))?,
        };
        limits.push(Window { limit, ..window });
    }
    Ok(ServeOptions {
        port,
        admin_port,
        data_dir: parsed.get("data").map(absolute_path),
        bind: parsed.get("bind").map(str::to_string),
        admin_bind: parsed.get("admin-bind").map(str::to_string),
        ip_header: read_header_name(parsed.get("ip-header"), "--ip-header")?,
        trusted_proxies,
        max_requests: parsed
            .get("max-requests")
            .map(|value| parse_positive_integer(value, "--max-requests"))
            .transpose()?
            .unwrap_or(DEFAULT_MAX_REQUESTS as u64),
        max_connections: parsed
            .get("max-connections")
            .map(|value| parse_positive_integer(value, "--max-connections"))
            .transpose()?
            .unwrap_or(DEFAULT_MAX_CONNECTIONS as u64),
        country_header: read_header_name(parsed.get("country-header"), "--country-header")?,
        allow_origins,
        min_free,
        tls_cert: parsed.get("tls-cert").map(absolute_path),
        tls_key: parsed.get("tls-key").map(absolute_path),
        limits,
    })
}

pub fn service_args(options: &ServeOptions, data_dir: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "server",
        "--port",
        &options.port.to_string(),
        "--admin-port",
        &options.admin_port.to_string(),
        "--data",
        data_dir,
    ]
    .iter()
    .map(|item| item.to_string())
    .collect();
    let mut push = |flag: &str, value: String| {
        args.push(flag.to_string());
        args.push(value);
    };
    if let Some(bind) = &options.bind {
        push("--bind", bind.clone());
    }
    if let Some(bind) = &options.admin_bind {
        push("--admin-bind", bind.clone());
    }
    if let Some(header) = &options.ip_header {
        push("--ip-header", header.clone());
        if options.trusted_proxies != default_trusted() {
            push("--trusted-proxy", options.trusted_proxies.join(","));
        }
    }
    if options.max_requests != DEFAULT_MAX_REQUESTS as u64 {
        push("--max-requests", options.max_requests.to_string());
    }
    if options.max_connections != DEFAULT_MAX_CONNECTIONS as u64 {
        push("--max-connections", options.max_connections.to_string());
    }
    if let Some(header) = &options.country_header {
        push("--country-header", header.clone());
    }
    if let Some(origins) = &options.allow_origins {
        push("--allow-origin", origins.join(","));
    }
    if options.min_free != DEFAULT_MIN_FREE {
        push("--min-free", options.min_free.clone());
    }
    if let (Some(cert), Some(key)) = (&options.tls_cert, &options.tls_key) {
        push("--tls-cert", cert.clone());
        push("--tls-key", key.clone());
    }
    for (window, defaults) in options.limits.iter().zip(default_limits()) {
        if window.limit != defaults.limit {
            push(
                &format!("--limit-{}", window.name),
                window.limit.to_string(),
            );
        }
    }
    args
}

fn update_line(auto_update: bool) -> &'static str {
    if auto_update {
        "Updates: once a day, to a compatible release that is 7 days old. Turn off: add --no-auto-update"
    } else {
        "Updates: off. Run sudo imp-aly update to update"
    }
}

fn print_banner(
    options: &ServeOptions,
    data_dir: &str,
    key: &str,
    key_path: &str,
    mode: &str,
    auto_update: bool,
) {
    let scheme = if options.tls_cert.is_some() {
        "https"
    } else {
        "http"
    };
    let addresses = match &options.bind {
        Some(bind) => vec![bind.clone()],
        None => local_addresses(),
    };
    let best = addresses
        .first()
        .cloned()
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let others = &addresses[addresses.len().min(1)..];
    let origin = format!("{scheme}://{}:{}", format_host(&best), options.port);
    let admin_origin = format!(
        "{scheme}://{}:{}",
        format_host(options.admin_bind.as_deref().unwrap_or(&best)),
        options.admin_port
    );
    let mode_line = match mode {
        "running" => format!("systemd service \"{SERVICE_NAME}\" is running"),
        "started" => format!("systemd service \"{SERVICE_NAME}\" started"),
        "installed" => format!("systemd service \"{SERVICE_NAME}\" installed and started"),
        "updated" => format!("systemd service \"{SERVICE_NAME}\" updated and restarted"),
        _ => "running in the foreground (no systemd service)".to_string(),
    };
    let service_lines = if mode == "foreground" {
        String::new()
    } else {
        format!(
            "\nLogs: journalctl -u {SERVICE_NAME} -f    Remove: sudo imp-aly server --uninstall\n{}\n",
            update_line(auto_update)
        )
    };
    let other_ips = if others.is_empty() {
        String::new()
    } else {
        format!("\n  Other IPs: {}", others.join(", "))
    };
    logger::plain(format!(
        "
imp-aly {VERSION} - {mode_line}

  Address:   {origin}{other_ips}
  Collect:   {origin}/collect/<app>
  Admin:     {admin_origin}  (the app, query, backup and status commands)
  Key:       {key}
  Key file:  {key_path}
  Data:      {data_dir}

Run this command again anytime to see the address and the key.
When the VPS has a public IP that is not listed, use that IP.
Open the port {} to the internet.
Open the port {} only to the machines that run the client commands.

Register an app (on this machine, or anywhere with --url <admin address> and -a):

  imp-aly app add myapp https://myapp.example/
{service_lines}",
        options.port, options.admin_port
    ));
}

const KEY_CHANGED: &str = "The key changed. The server refuses tokens signed with the old key.";

fn reload_key(server: &RunningServer, data_dir: &str, key_path: Option<&str>) {
    let result = match key_path {
        None => take_new_key(KEY_HANDOVER_DIR, data_dir, |key| server.set_key(key)),
        Some(path) => read_key_file(path).and_then(|key| {
            if !key.is_empty() {
                server.set_key(&key)?;
            }
            Ok(key)
        }),
    };
    match result {
        Ok(key) if !key.is_empty() => logger::info(KEY_CHANGED),
        Ok(_) => logger::warn(format!(
            "SIGHUP: {} has no key",
            key_path.map_or_else(|| join(&[KEY_HANDOVER_DIR, NEW_KEY_FILE]), str::to_string)
        )),
        Err(error) => logger::error(format!("SIGHUP: the key did not change ({error})")),
    }
}

pub async fn wait_for_stop() {
    let (Ok(mut interrupt), Ok(mut terminate)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
}

struct Run<'a> {
    options: &'a ServeOptions,
    data_dir: String,
    key: String,
    key_path: Option<String>,
    service: bool,
}

fn run(run: Run) -> Result<()> {
    let runtime = runtime()?;
    runtime.block_on(async {
        let options = run.options;
        let mut server_options = ServerOptions::new(&run.data_dir, &run.key);
        server_options.port = options.port;
        server_options.hostname = options.bind.clone();
        server_options.admin_port = options.admin_port;
        server_options.admin_hostname = options.admin_bind.clone();
        server_options.ip_header = options.ip_header.clone();
        server_options.trusted_proxies = options.trusted_proxies.clone();
        server_options.max_requests = options.max_requests as usize;
        server_options.max_connections = options.max_connections as usize;
        server_options.country_header = options.country_header.clone();
        server_options.allow_origins = options.allow_origins.clone();
        server_options.limits = options.limits.clone();
        server_options.min_free = Some(options.min_free.clone());
        let (restart, mut restart_requested) = mpsc::unbounded_channel::<()>();
        if run.service && options.tls_cert.is_some() {
            server_options.tls_cert = Some(credential_path(CREDENTIAL_TLS_CERT)?);
            server_options.tls_key = Some(credential_path(CREDENTIAL_TLS_KEY)?);
            server_options.tls_watch = Some(vec![
                options.tls_cert.clone().unwrap_or_default(),
                options.tls_key.clone().unwrap_or_default(),
            ]);
            server_options.on_tls_change = Some(Arc::new(move || {
                logger::info("The TLS certificate changed, the service restarts to load it");
                let _ = restart.send(());
                true
            }));
        } else {
            server_options.tls_cert = options.tls_cert.clone();
            server_options.tls_key = options.tls_key.clone();
        }
        let server = start_server(server_options).await?;
        if run.service {
            logger::info(format!(
                "imp-aly {VERSION} listens on port {}, and on port {} for admin",
                server.port, server.admin_port
            ));
        } else {
            print_banner(
                options,
                &run.data_dir,
                &run.key,
                run.key_path.as_deref().unwrap_or(""),
                "foreground",
                false,
            );
        }
        let mut hangup =
            signal(SignalKind::hangup()).map_err(|error| Error::new(error.to_string()))?;
        let stop = wait_for_stop();
        tokio::pin!(stop);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                _ = restart_requested.recv() => break,
                _ = hangup.recv() => reload_key(&server, &run.data_dir, run.key_path.as_deref()),
            }
        }
        logger::info("Shutting down...");
        server.shutdown().await;
        Ok(())
    })
}

pub fn server(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &SERVE_FLAGS, "server")?;
    if let Some(extra) = parsed.positional.get(1) {
        return Err(Error::new(format!(
            "server takes no argument \"{extra}\" - run imp-aly help"
        )));
    }
    if parsed.has("uninstall") {
        return uninstall_service();
    }
    let options = read_serve_options(parsed)?;
    if is_inside_service() {
        let data_dir = options
            .data_dir
            .clone()
            .unwrap_or_else(|| SERVICE_DATA_DIR.to_string());
        let key = find_key(Some(&credential_path(CREDENTIAL_KEY)?))?;
        return run(Run {
            options: &options,
            data_dir,
            key,
            key_path: None,
            service: true,
        });
    }
    let resolved = find_or_create_key(parsed.get("auth"), &default_key_path())?;
    let blocker = if parsed.has("foreground") {
        None
    } else {
        service_blocker()
    };
    if parsed.has("foreground") || blocker.is_some() {
        if let Some(blocker) = blocker {
            logger::warn(format!(
                "Cannot install the systemd service ({blocker}). The server runs in the foreground and does not start again after a reboot."
            ));
        }
        let data_dir = options
            .data_dir
            .clone()
            .unwrap_or_else(|| absolute_path(DEFAULT_DATA_DIR));
        return run(Run {
            options: &options,
            data_dir,
            key: resolved.key,
            key_path: Some(resolved.path),
            service: false,
        });
    }
    let data_dir = options
        .data_dir
        .clone()
        .unwrap_or_else(|| SERVICE_DATA_DIR.to_string());
    let auto_update = !parsed.has("no-auto-update");
    let args = service_args(&options, &data_dir);
    let mode = ensure_service(
        &UnitOptions {
            args: &args,
            data_dir: &data_dir,
            ports: &[options.port, options.admin_port],
            key_path: &resolved.path,
            tls_cert: options.tls_cert.as_deref(),
            tls_key: options.tls_key.as_deref(),
        },
        auto_update,
    )?;
    print_banner(
        &options,
        &data_dir,
        &resolved.key,
        &resolved.path,
        mode,
        auto_update,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::parse_args;

    fn parse(list: &[&str]) -> Parsed {
        parse_args(&list.iter().map(|item| item.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn server_options_are_validated_and_turn_into_service_arguments() {
        let options = read_serve_options(&parse(&["server"])).unwrap();
        assert_eq!(
            service_args(&options, "/var/lib/imp-aly"),
            [
                "server",
                "--port",
                "4411",
                "--admin-port",
                "4410",
                "--data",
                "/var/lib/imp-aly"
            ]
        );
        let options = read_serve_options(&parse(&[
            "server",
            "-p",
            "443",
            "--ip-header",
            "X-Forwarded-For",
            "--trusted-proxy",
            "10.0.0.0/8",
            "--max-requests",
            "64",
            "--max-connections",
            "512",
            "--allow-origin",
            "https://a.example",
            "--min-free",
            "5GB",
            "--limit-5s",
            "50",
        ]))
        .unwrap();
        assert_eq!(
            service_args(&options, "/data"),
            [
                "server",
                "--port",
                "443",
                "--admin-port",
                "4410",
                "--data",
                "/data",
                "--ip-header",
                "x-forwarded-for",
                "--trusted-proxy",
                "10.0.0.0/8",
                "--max-requests",
                "64",
                "--max-connections",
                "512",
                "--allow-origin",
                "https://a.example",
                "--min-free",
                "5GB",
                "--limit-5s",
                "50",
            ]
        );
        for bad in [
            vec!["server", "--port", "4410"],
            vec!["server", "--tls-cert", "a"],
            vec!["server", "--trusted-proxy", "10.0.0.0/8"],
            vec!["server", "--ip-header", "x", "--trusted-proxy", "nope"],
            vec!["server", "--min-free", "lots"],
            vec!["server", "--allow-origin", "https://a.example/"],
            vec!["server", "--ip-header", "bad header"],
            vec!["server", "--max-connections", "0"],
            vec!["server", "--limit-1m", "x"],
        ] {
            assert!(read_serve_options(&parse(&bad)).is_err(), "{bad:?}");
        }
    }
}
