mod demo_data;

use demo_data::{DEMO_APPS, Random, build_of, seed_lines, visit_records};
use imp_aly::api_client::{ApiTarget, call_server};
use imp_aly::auth::{generate_key, read_key_file, write_key_file};
use imp_aly::console::start_console;
use imp_aly::json::{self, Object, Value};
use imp_aly::server::{ServerOptions, start_server};
use imp_aly::source::open_source;
use imp_aly::static_files::Files;
use imp_aly::storage::apply_segment_text;
use imp_aly::update::{compare_versions, parse_version};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Duration;

const DAYS: i64 = 45;

const VISIT_EVERY: Duration = Duration::from_secs(3);

const COUNTRY_HEADER: &str = "x-demo-country";

const DEMO_ADMIN_PORT: u16 = 44889;

const DEMO_PORT: u16 = 44890;

fn root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    manifest.canonicalize().unwrap_or(manifest)
}

fn cargo(args: &[&str]) -> bool {
    println!("> cargo {}", args.join(" "));
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    Command::new(cargo)
        .args(args)
        .current_dir(root())
        .status()
        .is_ok_and(|status| status.success())
}

fn imp(args: &[&str]) -> bool {
    println!("> imp {}", args.join(" "));
    Command::new("imp")
        .args(args)
        .current_dir(root().join("console"))
        .status()
        .is_ok_and(|status| status.success())
}

fn verify() -> bool {
    cargo(&["fmt", "--all", "--check"])
        && cargo(&[
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ])
        && cargo(&["test", "--workspace"])
        && imp(&["fmt", "--check"])
        && imp(&["lint"])
        && imp(&["test", "--unit"])
}

fn console_build() -> bool {
    imp(&["build", "--pwa"])
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn tag_version(tag: &str) -> Option<String> {
    git(&["show", &format!("{tag}:Cargo.toml")])?
        .lines()
        .find_map(|line| line.strip_prefix("version = \""))
        .map(|rest| rest.trim_end_matches('"').to_string())
}

fn tag_format(tag: &str) -> Option<i64> {
    let source = git(&["show", &format!("{tag}:src/data_format.rs")])?;
    let line = source
        .lines()
        .find(|line| line.contains("DATA_FORMAT") && line.contains('='))?;
    let digits: String = line
        .split('=')
        .nth(1)?
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn versions_manifest() -> bool {
    let tags = git(&["tag", "--list", "v*"]).unwrap_or_default();
    let mut versions: Vec<(String, i64)> = Vec::new();
    for tag in tags.lines().filter(|tag| !tag.is_empty()) {
        let version = &tag[1..];
        if parse_version(version).is_none() || tag_version(tag).as_deref() != Some(version) {
            continue;
        }
        if let Some(format) = tag_format(tag) {
            versions.push((version.to_string(), format));
        }
    }
    versions.sort_by(|a, b| compare_versions(&b.0, &a.0));
    let list: Vec<Value> = versions
        .into_iter()
        .map(|(version, format)| {
            Object::new()
                .with("version", version)
                .with("format", format)
                .into()
        })
        .collect();
    println!(
        "{}",
        json::pretty(&Object::new().with("versions", Value::Array(list)).into())
    );
    true
}

struct DevData {
    root: PathBuf,
    data_dir: String,
    key: String,
    fresh: bool,
}

fn open_dev_data(reset: bool) -> Result<DevData, String> {
    let root = root().join(".dev-data");
    let data_dir = root.join("data");
    let key_path = root.join("key").to_string_lossy().into_owned();
    if reset {
        let _ = std::fs::remove_dir_all(&root);
    }
    let key = if data_dir.exists() {
        read_key_file(&key_path).map_err(|error| error.message)?
    } else {
        String::new()
    };
    let data_dir_text = data_dir.to_string_lossy().into_owned();
    if !key.is_empty() {
        return Ok(DevData {
            root,
            data_dir: data_dir_text,
            key,
            fresh: false,
        });
    }
    let _ = std::fs::remove_dir_all(&data_dir);
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let created = generate_key();
    write_key_file(&key_path, &created).map_err(|error| error.message)?;
    Ok(DevData {
        root,
        data_dir: data_dir_text,
        key: created,
        fresh: true,
    })
}

fn start(args: &[String]) -> Result<(), String> {
    let reset = args.iter().any(|arg| arg == "--reset");
    let port = match args.iter().position(|arg| arg == "--port") {
        Some(index) => args
            .get(index + 1)
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or("--port needs a port")?,
        None => imp_aly::console::DEFAULT_CONSOLE_PORT,
    };
    if !console_build() {
        return Err("the console page did not build - is imp installed?".to_string());
    }
    imp_aly::logger::set_quiet(true);
    let dev = open_dev_data(reset)?;
    let started = imp_aly::days::now_ms();
    let mut random = Random::new(if dev.fresh {
        42.0
    } else {
        (started % 2_147_483_648) as f64
    });
    let mut seeded = 0;
    if dev.fresh {
        let lines = seed_lines(&mut random, started, DAYS);
        let source = open_source(&dev.data_dir).map_err(|error| error.message)?;
        apply_segment_text(
            &dev.data_dir,
            &source,
            1,
            &format!("{}\n", lines.join("\n")),
        )
        .map_err(|error| error.message)?;
        seeded = lines.len();
    }
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let mut options = ServerOptions::new(&dev.data_dir, &dev.key);
        options.port = DEMO_PORT;
        options.admin_port = DEMO_ADMIN_PORT;
        options.hostname = Some("127.0.0.1".to_string());
        options.min_free = None;
        options.country_header = Some(COUNTRY_HEADER.to_string());
        let server = start_server(options).await.map_err(|error| error.message)?;
        let admin_url = format!("http://127.0.0.1:{}", server.admin_port);
        if dev.fresh {
            let target = ApiTarget {
                label: "demo".to_string(),
                url: admin_url.clone(),
                auth: Some(dev.key.clone()),
                server: Some("demo".to_string()),
                service: false,
            };
            for app in DEMO_APPS {
                let body: Value = Object::new()
                    .with("build", json::stringify(&build_of(app)))
                    .with(
                        "segments",
                        app.segments
                            .iter()
                            .map(|s| s.to_string())
                            .collect::<Vec<_>>(),
                    )
                    .into();
                let target = target.clone();
                let path = format!("/apps/{}", app.name);
                tokio::task::spawn_blocking(move || {
                    call_server(&target, "PUT", &path, Some(&body), Some(30_000))
                })
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.message)?;
            }
        }
        let console = start_console(port, Files::Folder(root().join("console").join("dist")))
            .await
            .map_err(|error| error.message)?;
        let public_port = server.port;
        let sender = tokio::spawn(async move {
            let mut sent = 0usize;
            let mut interval = tokio::time::interval(VISIT_EVERY);
            loop {
                interval.tick().await;
                let app = DEMO_APPS[sent % DEMO_APPS.len()];
                let visit = visit_records(
                    app,
                    &mut random,
                    &format!("live{started:x}-{sent}"),
                    imp_aly::days::now_ms(),
                    true,
                );
                sent += 1;
                let body = json::stringify(&Value::Array(
                    visit.records.into_iter().map(Value::Object).collect(),
                ));
                let url = format!("http://127.0.0.1:{public_port}/collect/{}", app.name);
                let country = visit.country;
                let _ = tokio::task::spawn_blocking(move || {
                    ureq::post(&url)
                        .header(COUNTRY_HEADER, country)
                        .send(body.as_bytes())
                })
                .await;
            }
        });
        let seeded_line = if dev.fresh {
            format!("{seeded} new records in {} days", DAYS + 1)
        } else {
            "the records of the last runs".to_string()
        };
        println!(
            "
imp-aly {} - demo

  Console:  {url}
  Collect:  http://127.0.0.1:{public_port}/collect/<app>
  Apps:     {}
  Data:     {seeded_line},
            and a new visit every {} seconds
  Folder:   {}

To add the demo server, open {url}/servers, press \"Add a server\",
and type these values:

  Name:     demo
  URL:      {admin_url}
  Key:      {}

Press Ctrl+C to stop. The folder stays for the next start.
To start again with new sample data, run \"cargo start --reset\".
",
            imp_aly::VERSION,
            DEMO_APPS
                .iter()
                .map(|app| app.name)
                .collect::<Vec<_>>()
                .join(", "),
            VISIT_EVERY.as_secs(),
            dev.root.display(),
            dev.key,
            url = console.url,
        );
        let _ = tokio::signal::ctrl_c().await;
        sender.abort();
        console.shutdown().await;
        server.shutdown().await;
        Ok(())
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let task = args.first().cloned().unwrap_or_default();
    let ok = match task.as_str() {
        "verify" => verify(),
        "console-build" => console_build(),
        "console" => {
            console_build() && cargo(&["run", "--quiet", "--package", "imp-aly", "--", "console"])
        }
        "compile" => {
            console_build() && cargo(&["build", "--release", "--locked", "--package", "imp-aly"])
        }
        "versions-manifest" => versions_manifest(),
        "start" => match start(&args[1..]) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("{error}");
                false
            }
        },
        _ => {
            eprintln!(
                "Usage: cargo xtask <verify|start|console|console-build|compile|versions-manifest>"
            );
            false
        }
    };
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
