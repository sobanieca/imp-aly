use crate::args::parse_args;
use crate::auth::{KEY_LOADED_FILE, hand_over_key, remove_file};
use crate::error::{Error, Result};
use crate::logger;
use crate::net::format_host;
use crate::paths::{dirname, join};
use std::fs;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const SERVICE_NAME: &str = "imp-aly";

pub const UNIT_PATH: &str = "/etc/systemd/system/imp-aly.service";

pub const SERVICE_ENV: &str = "IMP_ALY_SERVICE";

pub const SERVICE_USER: &str = "imp-aly";

pub const SERVICE_DATA_DIR: &str = "/var/lib/imp-aly";

pub const KEY_HANDOVER_DIR: &str = "/run/imp-aly";

pub const UPDATE_NAME: &str = "imp-aly-update";

pub const UPDATE_SERVICE_PATH: &str = "/etc/systemd/system/imp-aly-update.service";

pub const UPDATE_TIMER_PATH: &str = "/etc/systemd/system/imp-aly-update.timer";

pub const CREDENTIAL_KEY: &str = "key";

pub const CREDENTIAL_TLS_CERT: &str = "tls-cert";

pub const CREDENTIAL_TLS_KEY: &str = "tls-key";

const HOME_PREFIXES: [&str; 3] = ["/root/", "/home/", "/run/user/"];

const PRIVILEGED_PORTS: u16 = 1024;

const START_TIMEOUT: Duration = Duration::from_secs(5);

const HEALTH: Duration = Duration::from_secs(15);

const HEALTH_POLL: Duration = Duration::from_millis(500);

const KEY_LOAD: Duration = Duration::from_secs(5);

pub struct Output {
    pub code: i32,
    pub out: String,
    pub err: String,
}

pub fn run_command(program: &str, args: &[&str]) -> Output {
    match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(output) => Output {
            code: output.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            err: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(error) => Output {
            code: -1,
            out: String::new(),
            err: error.to_string(),
        },
    }
}

fn systemctl(args: &[&str]) -> Result<String> {
    let result = run_command("systemctl", args);
    if result.code != 0 {
        return Err(Error::new(format!(
            "systemctl {} failed: {}",
            args.join(" "),
            result.err
        )));
    }
    Ok(result.out)
}

fn must_run(program: &str, args: &[&str]) -> Result<()> {
    let result = run_command(program, args);
    if result.code != 0 {
        let reason = if result.err.is_empty() {
            format!("code {}", result.code)
        } else {
            result.err
        };
        return Err(Error::new(format!(
            "{program} {} failed: {reason}",
            args.join(" ")
        )));
    }
    Ok(())
}

pub fn is_inside_service() -> bool {
    std::env::var(SERVICE_ENV).is_ok_and(|value| value == "1")
}

pub fn credential_path(name: &str) -> Result<String> {
    match std::env::var("CREDENTIALS_DIRECTORY") {
        Ok(dir) if !dir.is_empty() => Ok(join(&[&dir, name])),
        _ => Err(Error::new(
            "the service has no credentials - run sudo imp-aly server again to update the unit file",
        )),
    }
}

fn is_under_home(path: &str) -> bool {
    HOME_PREFIXES
        .iter()
        .any(|prefix| format!("{path}/").starts_with(prefix))
}

pub fn is_root() -> bool {
    unsafe { libc::getuid() == 0 }
}

pub fn has_systemd() -> bool {
    fs::metadata("/run/systemd/system").is_ok_and(|meta| meta.is_dir())
}

pub fn service_blocker() -> Option<&'static str> {
    if std::env::consts::OS != "linux" {
        return Some("not on Linux");
    }
    if !has_systemd() {
        return Some("systemd not found");
    }
    if !is_root() {
        return Some("not running as root (try sudo)");
    }
    None
}

pub fn executable() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/usr/local/bin/imp-aly".to_string())
}

fn is_plain(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_@%$+=:,./-".contains(&byte))
}

pub fn quote(argument: &str) -> String {
    let escaped = argument.replace('%', "%%").replace('$', "$$");
    if is_plain(&escaped) {
        return escaped;
    }
    format!("\"{}\"", escaped.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn unquote(value: &str) -> String {
    let inner = if value.len() > 1 && value.starts_with('"') && value.ends_with('"') {
        let mut out = String::new();
        let mut chars = value[1..value.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        value.to_string()
    };
    inner.replace("$$", "$").replace("%%", "%")
}

fn unit_value(unit: &str, prefix: &str) -> Option<String> {
    unit.lines()
        .find(|line| line.starts_with(prefix))
        .map(|line| unquote(&line[prefix.len()..]))
}

pub struct UnitSettings {
    pub key_path: String,
    pub data_dir: String,
}

pub fn unit_settings(unit: &str) -> Result<UnitSettings> {
    let key_path = unit_value(unit, &format!("LoadCredential={CREDENTIAL_KEY}:"));
    let data_dir = unit_value(unit, "ReadWritePaths=");
    match (key_path, data_dir) {
        (Some(key_path), Some(data_dir)) if !key_path.is_empty() && !data_dir.is_empty() => {
            Ok(UnitSettings { key_path, data_dir })
        }
        _ => Err(Error::new(format!(
            "{UNIT_PATH} has no key file or no data folder - run sudo imp-aly server again"
        ))),
    }
}

fn split_unit_arguments(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let Some(&first) = chars.peek() else {
            return out;
        };
        let mut token = String::new();
        if first == '"' {
            token.push(chars.next().unwrap_or('"'));
            while let Some(c) = chars.next() {
                token.push(c);
                if c == '\\' {
                    if let Some(next) = chars.next() {
                        token.push(next);
                    }
                } else if c == '"' {
                    break;
                }
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                token.push(c);
                chars.next();
            }
        }
        out.push(unquote(&token));
    }
}

fn exec_arguments(unit: &str) -> Option<Vec<String>> {
    unit.lines()
        .find(|line| line.starts_with("ExecStart="))
        .map(|line| split_unit_arguments(&line["ExecStart=".len()..]))
}

pub struct ServiceTarget {
    pub url: String,
    pub key_path: String,
}

pub fn service_target(unit: Option<&str>) -> Option<ServiceTarget> {
    let unit = unit?;
    let command = exec_arguments(unit)?;
    let start = command.iter().position(|argument| argument == "server")?;
    if start < 1 {
        return None;
    }
    let parsed = parse_args(&command[start + 1..]).ok()?;
    let settings = unit_settings(unit).ok()?;
    let admin_port = parsed.get("admin-port")?;
    let bound = parsed
        .get("admin-bind")
        .or(parsed.get("bind"))
        .unwrap_or("127.0.0.1");
    let host = match bound {
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        other => other,
    };
    let scheme = if parsed.has("tls-cert") {
        "https"
    } else {
        "http"
    };
    Some(ServiceTarget {
        url: format!("{scheme}://{}:{admin_port}", format_host(host)),
        key_path: settings.key_path,
    })
}

pub fn read_unit() -> Option<String> {
    fs::read_to_string(UNIT_PATH).ok()
}

pub fn local_service() -> Option<ServiceTarget> {
    service_target(read_unit().as_deref())
}

pub struct UnitOptions<'a> {
    pub args: &'a [String],
    pub data_dir: &'a str,
    pub ports: &'a [u16],
    pub key_path: &'a str,
    pub tls_cert: Option<&'a str>,
    pub tls_key: Option<&'a str>,
}

pub fn unit_file(options: &UnitOptions, binary: &str) -> String {
    let capabilities = if options.ports.iter().any(|port| *port < PRIVILEGED_PORTS) {
        "CAP_NET_BIND_SERVICE"
    } else {
        ""
    };
    let mut credentials = vec![format!(
        "LoadCredential={CREDENTIAL_KEY}:{}",
        quote(options.key_path)
    )];
    if let (Some(cert), Some(key)) = (options.tls_cert, options.tls_key) {
        credentials.push(format!(
            "LoadCredential={CREDENTIAL_TLS_CERT}:{}",
            quote(cert)
        ));
        credentials.push(format!(
            "LoadCredential={CREDENTIAL_TLS_KEY}:{}",
            quote(key)
        ));
    }
    let exec: Vec<String> = std::iter::once(binary.to_string())
        .chain(options.args.iter().cloned())
        .map(|argument| quote(&argument))
        .collect();
    let protect_home = if is_under_home(options.data_dir) {
        "read-only"
    } else {
        "true"
    };
    format!(
        "[Unit]
Description=imp-aly analytics server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart={}
User={SERVICE_USER}
Group={SERVICE_USER}
Restart=always
RestartSec=3
LimitNOFILE=65536
TasksMax=4096
Environment={SERVICE_ENV}=1
{}
UMask=0077
ReadWritePaths={}
ProtectSystem=strict
ProtectHome={protect_home}
PrivateTmp=true
PrivateDevices=true
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet={capabilities}
AmbientCapabilities={capabilities}

[Install]
WantedBy=multi-user.target
",
        exec.join(" "),
        credentials.join("\n"),
        quote(options.data_dir)
    )
}

pub fn update_service_file(binary: &str) -> String {
    format!(
        "[Unit]
Description=imp-aly automatic update in the same major version
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart={} update --auto
StateDirectory={UPDATE_NAME}
ReadWritePaths={}
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_FOWNER
",
        quote(binary),
        quote(&dirname(binary))
    )
}

pub fn update_timer_file() -> String {
    "[Unit]
Description=Daily check for a new imp-aly version

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
"
    .to_string()
}

fn nologin_shell() -> &'static str {
    ["/usr/sbin/nologin", "/sbin/nologin"]
        .into_iter()
        .find(|path| fs::metadata(path).is_ok_and(|meta| meta.is_file()))
        .unwrap_or("/bin/false")
}

pub fn service_problems(
    data_dir: &str,
    key_path: &str,
    tls_cert: Option<&str>,
    tls_key: Option<&str>,
    binary: &str,
) -> Vec<String> {
    let mut problems = Vec::new();
    for path in [Some(key_path), tls_cert, tls_key].into_iter().flatten() {
        if quote(path) != path {
            problems.push(format!(
                "the service cannot load {path} - use a path of letters, digits and \"/._-\""
            ));
        }
    }
    if data_dir.starts_with("/root/") || data_dir == "/root" {
        problems.push(format!(
            "the service user cannot reach {data_dir} - use a folder outside /root, like {SERVICE_DATA_DIR}"
        ));
    }
    if is_under_home(binary) {
        problems.push(format!(
            "the service cannot run {binary}, because the service hides /root and /home - install imp-aly in /usr/local/bin"
        ));
    }
    problems
}

fn id_of(flag: &str) -> Result<u32> {
    let result = run_command("id", &[flag, SERVICE_USER]);
    match result.out.parse::<u32>() {
        Ok(id) if result.code == 0 => Ok(id),
        _ => Err(Error::new(format!("the user {SERVICE_USER} is missing"))),
    }
}

fn ensure_user() -> Result<()> {
    if run_command("id", &["-u", SERVICE_USER]).code == 0 {
        return Ok(());
    }
    must_run(
        "useradd",
        &[
            "--system",
            "--user-group",
            "--no-create-home",
            "--home-dir",
            "/nonexistent",
            "--shell",
            nologin_shell(),
            SERVICE_USER,
        ],
    )?;
    logger::info(format!("Created the system user {SERVICE_USER}"));
    Ok(())
}

fn first_missing_folder(path: &str) -> Option<String> {
    let mut missing = None;
    let mut current = path.to_string();
    while fs::metadata(&current).is_err() {
        missing = Some(current.clone());
        let parent = dirname(&current);
        if parent == current {
            break;
        }
        current = parent;
    }
    missing
}

fn service_user_can(test: &str, path: &str) -> bool {
    run_command("runuser", &["-u", SERVICE_USER, "--", "test", test, path]).code != 1
}

fn cannot_write(data_dir: &str) -> Error {
    Error::new(format!(
        "the user {SERVICE_USER} cannot write {data_dir} - give it access to the parent folders, or use {SERVICE_DATA_DIR}"
    ))
}

fn prepare_data_dir(data_dir: &str) -> Result<()> {
    let created = first_missing_folder(data_dir);
    let parent = dirname(created.as_deref().unwrap_or(data_dir));
    if !service_user_can("-x", &parent) {
        return Err(cannot_write(data_dir));
    }
    fs::create_dir_all(data_dir).map_err(|error| Error::io(&error, data_dir))?;
    let prepared = (|| -> Result<()> {
        must_run(
            "chown",
            &["-R", &format!("{SERVICE_USER}:{SERVICE_USER}"), data_dir],
        )?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| Error::io(&error, data_dir))?;
        if !service_user_can("-w", data_dir) {
            return Err(cannot_write(data_dir));
        }
        Ok(())
    })();
    if let Err(error) = prepared {
        if let Some(created) = created {
            let _ = fs::remove_dir_all(created);
        }
        return Err(error);
    }
    Ok(())
}

pub fn is_service_installed() -> bool {
    read_unit().is_some()
}

fn sync_file(path: &str, wanted: Option<&str>) -> Result<bool> {
    let current = fs::read_to_string(path).ok();
    if current.as_deref() == wanted {
        return Ok(false);
    }
    match wanted {
        None => {
            fs::remove_file(path).map_err(|error| Error::io(&error, path))?;
            logger::info(format!("Removed {path}"));
        }
        Some(text) => {
            write_unit(path, text)?;
            logger::info(format!(
                "{} {path}",
                if current.is_some() {
                    "Updated"
                } else {
                    "Wrote"
                }
            ));
        }
    }
    Ok(true)
}

fn write_unit(path: &str, text: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, text).map_err(|error| Error::io(&error, path))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o644))
        .map_err(|error| Error::io(&error, path))
}

fn ensure_update_timer(enabled: bool, binary: &str) -> Result<()> {
    let timer = format!("{UPDATE_NAME}.timer");
    if !enabled && fs::metadata(UPDATE_TIMER_PATH).is_ok() {
        let _ = run_command("systemctl", &["disable", "--now", &timer]);
    }
    let service = update_service_file(binary);
    let timer_file = update_timer_file();
    let changed = [
        sync_file(UPDATE_SERVICE_PATH, enabled.then_some(service.as_str()))?,
        sync_file(UPDATE_TIMER_PATH, enabled.then_some(timer_file.as_str()))?,
    ]
    .contains(&true);
    if changed {
        systemctl(&["daemon-reload"])?;
    }
    if enabled {
        systemctl(&["enable", "--now", &timer])?;
    }
    Ok(())
}

pub fn is_active() -> bool {
    run_command("systemctl", &["is-active", SERVICE_NAME]).out == "active"
}

fn wait_until_active() -> bool {
    let start = Instant::now();
    while start.elapsed() < START_TIMEOUT {
        if is_active() {
            std::thread::sleep(Duration::from_secs(1));
            if is_active() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

pub fn ensure_service(options: &UnitOptions, auto_update: bool) -> Result<&'static str> {
    let binary = executable();
    let problems = service_problems(
        options.data_dir,
        options.key_path,
        options.tls_cert,
        options.tls_key,
        &binary,
    );
    if !problems.is_empty() {
        return Err(Error::new(problems.join("\n")));
    }
    let state = ensure_server_unit(options, &binary)?;
    ensure_update_timer(auto_update, &binary)?;
    Ok(state)
}

fn ensure_server_unit(options: &UnitOptions, binary: &str) -> Result<&'static str> {
    let wanted = unit_file(options, binary);
    let current = read_unit();
    if current.as_deref() == Some(wanted.as_str()) && is_active() {
        return Ok("running");
    }
    ensure_user()?;
    prepare_data_dir(options.data_dir)?;
    let state = if current.as_deref() == Some(wanted.as_str()) {
        systemctl(&["enable", "--now", SERVICE_NAME])?;
        "started"
    } else {
        write_unit(UNIT_PATH, &wanted)?;
        logger::info(format!(
            "{} {UNIT_PATH}",
            if current.is_some() {
                "Updated"
            } else {
                "Wrote"
            }
        ));
        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", SERVICE_NAME])?;
        systemctl(&["restart", SERVICE_NAME])?;
        if current.is_some() {
            "updated"
        } else {
            "installed"
        }
    };
    if !wait_until_active() {
        return Err(Error::new(format!(
            "the service {SERVICE_NAME} did not start - check: journalctl -u {SERVICE_NAME} -n 30"
        )));
    }
    Ok(state)
}

fn show_service() -> Vec<(String, String)> {
    let result = run_command(
        "systemctl",
        &[
            "show",
            SERVICE_NAME,
            "--property=ActiveState,MainPID,NRestarts",
        ],
    );
    result
        .out
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn property<'a>(properties: &'a [(String, String)], name: &str) -> Option<&'a str> {
    properties
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

pub fn restart_service() -> Result<bool> {
    systemctl(&["restart", SERVICE_NAME])?;
    let first = show_service();
    let start = Instant::now();
    while start.elapsed() < HEALTH {
        let now = show_service();
        if property(&now, "ActiveState") != Some("active")
            || property(&now, "MainPID") != property(&first, "MainPID")
            || property(&now, "NRestarts") != property(&first, "NRestarts")
        {
            return Ok(false);
        }
        std::thread::sleep(HEALTH_POLL);
    }
    Ok(true)
}

pub fn send_key_to_service(data_dir: &str, key: &str) -> Result<bool> {
    let loaded = join(&[data_dir, KEY_LOADED_FILE]);
    remove_file(&loaded)?;
    let path = hand_over_key(KEY_HANDOVER_DIR, key, 0, id_of("-g")?)?;
    let result = (|| -> Result<bool> {
        systemctl(&["kill", "--kill-whom=main", "--signal=SIGHUP", SERVICE_NAME])?;
        let start = Instant::now();
        while start.elapsed() < KEY_LOAD {
            if fs::symlink_metadata(&loaded).is_ok() {
                return Ok(true);
            }
            std::thread::sleep(HEALTH_POLL);
        }
        Ok(false)
    })();
    let _ = remove_file(&path);
    result
}

pub fn uninstall_service() -> Result<()> {
    ensure_update_timer(false, &executable())?;
    let result = run_command("systemctl", &["disable", "--now", SERVICE_NAME]);
    if result.code != 0 {
        logger::warn(result.err);
    }
    match fs::remove_file(UNIT_PATH) {
        Ok(()) => logger::info(format!("Removed {UNIT_PATH}")),
        Err(_) => logger::warn(format!("{UNIT_PATH} was not found")),
    }
    systemctl(&["daemon-reload"])?;
    logger::info(format!(
        "The service {SERVICE_NAME} is removed. The data folder, the key file and the user {SERVICE_USER} stay."
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn the_unit_file_runs_the_server_as_a_restricted_user() {
        let arguments = args(&[
            "server",
            "--port",
            "443",
            "--admin-port",
            "4410",
            "--data",
            "/var/lib/imp-aly",
            "--tls-cert",
            "/etc/letsencrypt/live/a/fullchain.pem",
            "--tls-key",
            "/etc/letsencrypt/live/a/privkey.pem",
        ]);
        let unit = unit_file(
            &UnitOptions {
                args: &arguments,
                data_dir: "/var/lib/imp-aly",
                ports: &[443, 4410],
                key_path: "/root/.secret/imp-aly-key",
                tls_cert: Some("/etc/letsencrypt/live/a/fullchain.pem"),
                tls_key: Some("/etc/letsencrypt/live/a/privkey.pem"),
            },
            "/usr/local/bin/imp-aly",
        );
        assert!(unit.contains("ExecStart=/usr/local/bin/imp-aly server --port 443 --admin-port 4410 --data /var/lib/imp-aly --tls-cert"));
        assert!(unit.contains("User=imp-aly\n"));
        assert!(unit.contains("LoadCredential=key:/root/.secret/imp-aly-key\n"));
        assert!(unit.contains("LoadCredential=tls-cert:/etc/letsencrypt/live/a/fullchain.pem\n"));
        assert!(unit.contains("ReadWritePaths=/var/lib/imp-aly\n"));
        assert!(unit.contains("ProtectHome=true\n"));
        assert!(unit.contains("CapabilityBoundingSet=CAP_NET_BIND_SERVICE\n"));
        assert!(unit.contains("NoNewPrivileges=true\n"));
        let target = service_target(Some(&unit)).unwrap();
        assert_eq!(target.url, "https://127.0.0.1:4410");
        assert_eq!(target.key_path, "/root/.secret/imp-aly-key");
        let settings = unit_settings(&unit).unwrap();
        assert_eq!(settings.data_dir, "/var/lib/imp-aly");
    }

    #[test]
    fn the_service_refuses_a_data_folder_in_root_and_paths_it_cannot_load() {
        let problems =
            service_problems("/root/data", "/root/my key", None, None, "/home/me/imp-aly");
        assert_eq!(problems.len(), 3);
        assert!(
            service_problems(
                "/var/lib/imp-aly",
                "/root/.secret/imp-aly-key",
                None,
                None,
                "/usr/local/bin/imp-aly"
            )
            .is_empty()
        );
    }

    #[test]
    fn unit_arguments_escape_systemd_specifiers_and_variables() {
        assert_eq!(quote("50%"), "50%%");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("$HOME"), "$$HOME");
        for text in ["50%", "a b", "$HOME", "x\"y", "back\\slash"] {
            assert_eq!(unquote(&quote(text)), text);
        }
        assert_eq!(split_unit_arguments("a \"b c\" d"), ["a", "b c", "d"]);
    }

    #[test]
    fn the_update_units_run_imp_aly_update_once_a_day() {
        let service = update_service_file("/usr/local/bin/imp-aly");
        assert!(service.contains("ExecStart=/usr/local/bin/imp-aly update --auto\n"));
        assert!(service.contains("ReadWritePaths=/usr/local/bin\n"));
        assert!(update_timer_file().contains("OnCalendar=daily\n"));
    }
}
