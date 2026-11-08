use super::status::selection;
use crate::api_client::{
    ApiTarget, CALL_TIMEOUT_MS, Settled, call_server, each_server, resolve_all,
};
use crate::app_build::BUILD_FILE;
use crate::args::{Parsed, parse_timeout, require_only_flags};
use crate::error::{Error, Result};
use crate::json::{self, Object, Value};
use crate::logger;
use crate::paths::join;
use crate::table::format_table;
use crate::url::encode_component;

const USAGE: &str = "use one of:
  imp-aly app add <name> <app url or build folder> [--segments plan,role] [--origins <list>]
  imp-aly app ls
  imp-aly app show <name>
  imp-aly app refresh <name>
  imp-aly app rm <name>";

fn is_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn count(app: &Value, key: &str) -> usize {
    app.get(key).and_then(Value::as_array).map_or(0, Vec::len)
}

fn texts(app: &Value, key: &str) -> Vec<String> {
    app.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn joined(app: &Value, key: &str) -> String {
    let list = texts(app, key);
    if list.is_empty() {
        "-".to_string()
    } else {
        list.join(", ")
    }
}

fn summary(app: &Value) -> String {
    format!(
        "{}: {} pages, {} zones, {} outcomes, segments {}, origins {}, build {}",
        app.get_str("name").unwrap_or(""),
        count(app, "pages"),
        count(app, "zones"),
        count(app, "outcomes"),
        joined(app, "segments"),
        joined(app, "origins"),
        app.get_str("appUrl").unwrap_or("uploaded")
    )
}

fn report<T>(settled: &Settled<T>) {
    for (server, reason) in &settled.failed {
        logger::error(format!("{server}: {reason}"));
    }
}

fn finish<T>(settled: &Settled<T>, targets: &[ApiTarget]) -> Result<()> {
    if settled.failed.is_empty() {
        return Ok(());
    }
    Err(Error::new(format!(
        "the command failed on {} of {} servers: {}",
        settled.failed.len(),
        targets.len(),
        settled
            .failed
            .iter()
            .map(|(server, _)| server.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

fn read_build_folder(folder: &str) -> Result<String> {
    let meta = std::fs::metadata(folder)
        .map_err(|error| Error::new(format!("cannot read the build folder {folder}: {error}")))?;
    if !meta.is_dir() {
        return Err(Error::new(format!(
            "{folder} is not a folder - give the build folder that holds {BUILD_FILE}"
        )));
    }
    let path = join(&[folder, BUILD_FILE]);
    std::fs::read_to_string(&path)
        .map_err(|error| Error::new(format!("cannot read {path}: {error}")))
}

fn split_list(value: Option<&str>) -> Vec<String> {
    value
        .map(|list| {
            list.split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn add_body(source: &str, segments: &[String], origins: &[String]) -> Result<Value> {
    let mut body = Object::new();
    if is_url(source) {
        body.insert("appUrl", source);
    } else {
        body.insert("build", read_build_folder(source)?);
    }
    body.insert("segments", segments.to_vec());
    if !origins.is_empty() {
        body.insert("origins", origins.to_vec());
    }
    Ok(body.into())
}

pub fn app(parsed: &Parsed) -> Result<()> {
    let action = parsed.positional.get(1).map(String::as_str);
    let name = parsed.positional.get(2);
    let source = parsed.positional.get(3);
    let rest = parsed.positional.len() > 4;
    if action == Some("add") {
        require_only_flags(
            parsed,
            &["auth", "url", "server", "segments", "origins", "timeout"],
            "app add",
        )?;
    } else {
        let command = format!("app {}", action.unwrap_or("")).trim().to_string();
        require_only_flags(
            parsed,
            &["auth", "url", "server", "json", "timeout"],
            &command,
        )?;
    }
    let targets = resolve_all(&selection(parsed))?;
    let timeout = Some(parse_timeout(parsed.get("timeout"))?.unwrap_or(CALL_TIMEOUT_MS));
    let many = targets.len() > 1;
    let prefix = |server: &str| {
        if many {
            format!("{server}: ")
        } else {
            String::new()
        }
    };
    match action {
        Some("add") => {
            let (Some(name), Some(source), false) = (name, source, rest) else {
                return Err(Error::new(USAGE));
            };
            let segments = split_list(parsed.get("segments"));
            let origins = split_list(parsed.get("origins"));
            if parsed.has("origins") && origins.is_empty() {
                return Err(Error::new("--origins needs at least one origin"));
            }
            let body = add_body(source, &segments, &origins)?;
            if origins.is_empty() && !is_url(source) {
                return Err(Error::new(
                    "an uploaded build needs --origins, the browser origins of the app, like --origins https://myapp.example",
                ));
            }
            let path = format!("/apps/{}", encode_component(name));
            let settled = each_server(&targets, |target| {
                call_server(target, "PUT", &path, Some(&body), timeout)
            })?;
            report(&settled);
            for (server, result) in &settled.results {
                logger::plain(format!("{}Registered {}", prefix(server), summary(result)));
            }
            if let Some((_, result)) = settled.results.first() {
                logger::plain(format!(
                    "Send records to /collect/{}",
                    result.get_str("name").unwrap_or(name)
                ));
            }
            finish(&settled, &targets)
        }
        Some("ls") => {
            if name.is_some() {
                return Err(Error::new(USAGE));
            }
            let settled = each_server(&targets, |target| {
                call_server(target, "GET", "/apps", None, timeout)
            })?;
            report(&settled);
            let mut apps: Vec<Value> = Vec::new();
            for (server, result) in &settled.results {
                for entry in result
                    .get("apps")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let mut entry = entry.as_object().cloned().unwrap_or_default();
                    if many {
                        let mut with_server = Object::new().with("server", server.clone());
                        for (key, value) in entry.iter() {
                            with_server.insert(key.clone(), value.clone());
                        }
                        entry = with_server;
                    }
                    apps.push(Value::Object(entry));
                }
            }
            if parsed.has("json") {
                println!("{}", json::pretty(&Value::Array(apps)));
            } else if apps.is_empty() {
                logger::plain("No app is registered.");
            } else {
                let columns = [
                    "name",
                    "pages",
                    "zones",
                    "outcomes",
                    "segments",
                    "origins",
                    "accepted",
                    "rejected",
                    "build",
                    "buildError",
                ];
                let mut header: Vec<&str> = Vec::new();
                if many {
                    header.push("server");
                }
                header.extend(columns);
                let rows: Vec<Value> = apps
                    .iter()
                    .map(|entry| {
                        let mut row = entry.as_object().cloned().unwrap_or_default();
                        row.insert("pages", count(entry, "pages"));
                        row.insert("zones", count(entry, "zones"));
                        row.insert("outcomes", count(entry, "outcomes"));
                        for key in ["segments", "origins"] {
                            let list = texts(entry, key).join(",");
                            row.insert(
                                key,
                                if list.is_empty() {
                                    Value::Null
                                } else {
                                    Value::from(list)
                                },
                            );
                        }
                        row.insert("build", entry.get_str("appUrl").unwrap_or("uploaded"));
                        Value::Object(row)
                    })
                    .collect();
                logger::plain(format_table(&header, &rows));
            }
            finish(&settled, &targets)
        }
        Some(action @ ("show" | "refresh" | "rm")) => {
            let (Some(name), None) = (name, source) else {
                return Err(Error::new(USAGE));
            };
            let path = format!("/apps/{}", encode_component(name));
            match action {
                "show" => {
                    let settled = each_server(&targets, |target| {
                        call_server(target, "GET", &path, None, timeout)
                    })?;
                    report(&settled);
                    let shown = if many {
                        Value::Array(
                            settled
                                .results
                                .iter()
                                .map(|(server, result)| {
                                    let mut entry = Object::new().with("server", server.clone());
                                    if let Some(object) = result.as_object() {
                                        for (key, value) in object.iter() {
                                            entry.insert(key.clone(), value.clone());
                                        }
                                    }
                                    Value::Object(entry)
                                })
                                .collect(),
                        )
                    } else {
                        settled
                            .results
                            .first()
                            .map(|(_, result)| result.clone())
                            .unwrap_or(Value::Null)
                    };
                    println!("{}", json::pretty(&shown));
                    finish(&settled, &targets)
                }
                "refresh" => {
                    let refresh_path = format!("{path}/refresh");
                    let settled = each_server(&targets, |target| {
                        let result = call_server(target, "POST", &refresh_path, None, timeout)?;
                        if let Some(problem) = result.get_str("buildError") {
                            return Err(Error::new(format!(
                                "the build of {name} could not be read: {problem}"
                            )));
                        }
                        Ok(result)
                    })?;
                    report(&settled);
                    for (server, result) in &settled.results {
                        logger::plain(format!("{}Refreshed {}", prefix(server), summary(result)));
                    }
                    finish(&settled, &targets)
                }
                _ => {
                    let settled = each_server(&targets, |target| {
                        call_server(target, "DELETE", &path, None, timeout)
                    })?;
                    report(&settled);
                    for (server, _) in &settled.results {
                        logger::plain(format!(
                            "{}Removed {name}. Its stored data stays until the retention removes it.",
                            prefix(server)
                        ));
                    }
                    finish(&settled, &targets)
                }
            }
        }
        _ => Err(Error::new(USAGE)),
    }
}
