use super::status::selection;
use super::token::hash_file;
use crate::api_client::{Body, Call, fetch_server, read_json, resolve_one};
use crate::args::{Parsed, require_only_flags};
use crate::error::{Error, Result};
use crate::json::{self, Value};
use crate::logger;
use crate::table::format_table;
use std::fs::File;

pub fn restore(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth", "url", "server", "json"], "restore")?;
    let (Some(file), 2) = (parsed.positional.get(1), parsed.positional.len()) else {
        return Err(Error::new("use: imp-aly restore <file>"));
    };
    let hash = hash_file(file, "backup")?;
    let input = File::open(file)
        .map_err(|error| Error::new(format!("cannot read the backup {file}: {error}")))?;
    let length = input.metadata().map(|meta| meta.len()).unwrap_or(0);
    let target = resolve_one(&selection(parsed))?;
    let response = fetch_server(
        &target,
        Call {
            method: "POST",
            path: "/restore",
            body: Body::Reader {
                reader: Box::new(input),
                length,
                hash,
                content_type: "application/gzip",
            },
            timeout_ms: None,
        },
    )?;
    let result = read_json(response, &target, "POST", "/restore", None)?;
    if parsed.has("json") {
        println!("{}", json::pretty(&result));
        return Ok(());
    }
    let list = |key: &str| {
        result
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let restored = list("restored");
    let skipped = list("skipped");
    logger::plain(format!(
        "Restored {} summaries. Skipped {}.",
        restored.len(),
        skipped.len()
    ));
    if !skipped.is_empty() {
        let columns: Vec<&str> = ["app", "day", "week", "month", "source", "reason"]
            .into_iter()
            .filter(|column| {
                ["app", "source", "reason"].contains(column)
                    || skipped.iter().any(|entry| entry.get(column).is_some())
            })
            .collect();
        logger::plain(format!("\n{}", format_table(&columns, &skipped)));
    }
    Ok(())
}
