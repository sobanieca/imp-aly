use super::status::selection;
use crate::api_client::{query_servers, resolve_all};
use crate::args::{Parsed, parse_timeout, require_only_flags};
use crate::error::{Error, Result};
use crate::json::{self, Value};
use crate::logger;
use crate::table::format_table;

fn read_query(argument: &str) -> Result<Value> {
    let text = if argument.trim().starts_with('{') {
        argument.to_string()
    } else {
        std::fs::read_to_string(argument).map_err(|error| {
            Error::new(format!(
                "\"{argument}\" is not a JSON query and not a readable file: {error}"
            ))
        })?
    };
    json::parse(&text).map_err(|_| Error::new("the query is not valid JSON"))
}

fn rows(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

pub fn query(parsed: &Parsed) -> Result<()> {
    require_only_flags(
        parsed,
        &["auth", "url", "server", "json", "timeout"],
        "query",
    )?;
    let (Some(argument), 2) = (parsed.positional.get(1), parsed.positional.len()) else {
        return Err(Error::new(
            "use: imp-aly query '<json>' or query <file.json>",
        ));
    };
    let timeout = parse_timeout(parsed.get("timeout"))?;
    let body = read_query(argument)?;
    let targets = resolve_all(&selection(parsed))?;
    let outcome = query_servers(&targets, &body, timeout)?;
    let result = Value::Object(outcome.result.clone());
    if parsed.has("json") {
        println!("{}", json::pretty(&result));
    } else {
        let columns: Vec<&str> = outcome
            .parsed
            .group_by
            .iter()
            .chain(outcome.parsed.measures.iter())
            .map(String::as_str)
            .collect();
        let table_rows = rows(result.get("rows"));
        logger::plain(format_table(&columns, &table_rows));
        let number = |key: &str| json::stringify(result.get(key).unwrap_or(&Value::Null));
        logger::plain(format!(
            "\n{} rows{} | {} days | {} records scanned | {} matched",
            table_rows.len(),
            if result.get("truncated") == Some(&Value::Bool(true)) {
                " (truncated by limit)"
            } else {
                ""
            },
            number("days"),
            number("scanned"),
            number("matched")
        ));
        if targets.len() > 1 {
            logger::plain("");
            let mut servers = rows(result.get("servers"));
            for (server, _) in &outcome.failed {
                servers.push(json::Object::new().with("server", server.clone()).into());
            }
            logger::plain(format_table(
                &["server", "days", "summaryDays", "scanned", "matched"],
                &servers,
            ));
        }
        let skipped = rows(result.get("skippedDays"));
        if !skipped.is_empty() {
            logger::plain(format!(
                "\nSkipped {} days that the query cannot read:",
                skipped.len()
            ));
            let columns: &[&str] = if targets.len() > 1 {
                &["server", "day", "source", "reason"]
            } else {
                &["day", "source", "reason"]
            };
            logger::plain(format_table(columns, &skipped));
        }
    }
    for warning in &outcome.warnings {
        logger::warn(warning);
    }
    if !outcome.failed.is_empty() {
        return Err(Error::new(format!(
            "the result is not complete - {} of {} servers did not answer:\n{}",
            outcome.failed.len(),
            targets.len(),
            outcome
                .failed
                .iter()
                .map(|(_, reason)| format!("  {reason}"))
                .collect::<Vec<_>>()
                .join("\n")
        )));
    }
    Ok(())
}
