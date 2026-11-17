use super::status::selection;
use crate::agent_keys::{AGENT_KEY_HOURS, hours_text};
use crate::api_client::{CALL_TIMEOUT_MS, call_server, resolve_one};
use crate::args::{Parsed, parse_timeout, require_only_flags};
use crate::auth::{generate_key, read_key_file, resolve_key, write_key_file};
use crate::error::{Error, Result};
use crate::json::{self, Object, Value};
use crate::logger;
use crate::servers::{load_servers, servers_path};
use crate::service::{
    SERVICE_NAME, is_active, is_root, read_unit, send_key_to_service, unit_settings,
};
use crate::table::format_table;
use crate::url::encode_component;

const USAGE: &str = "use one of:
  imp-aly key rotate [-a <key file>]
  imp-aly key add <name> --for <1h | 4h | 8h | 24h> [-s <server>]
  imp-aly key ls [-s <server>]
  imp-aly key rm <name> [-s <server>]";

fn rotate_service_key(unit: &str, key: &str, auth: Option<&str>) -> Result<(String, String)> {
    if !is_root() {
        return Err(Error::new(
            "the key of the service changes only as root - use sudo",
        ));
    }
    let settings = unit_settings(unit)?;
    if auth.is_some() {
        return Err(Error::new(format!(
            "the service loads its key from {} - run the command without -a",
            settings.key_path
        )));
    }
    let old = read_key_file(&settings.key_path)?;
    write_key_file(&settings.key_path, key)?;
    if !is_active() {
        logger::info(format!(
            "The service {SERVICE_NAME} does not run. It loads the new key when it starts."
        ));
    } else if send_key_to_service(&settings.data_dir, key)? {
        logger::info(format!(
            "The service {SERVICE_NAME} uses the new key and refuses the old key. It did not stop."
        ));
    } else {
        return Err(Error::new(format!(
            "the service {SERVICE_NAME} did not load the new key - check: journalctl -u {SERVICE_NAME} -n 30, then run: sudo systemctl restart {SERVICE_NAME}"
        )));
    }
    Ok((settings.key_path, old))
}

fn rotate_key_file(key: &str, auth: Option<&str>) -> Result<(String, String)> {
    let path = resolve_key(auth)?.path;
    if path.is_empty() {
        return Err(Error::new(
            "-a takes the path of the key file here, not a key",
        ));
    }
    let old = read_key_file(&path)?;
    if old.is_empty() {
        return Err(Error::new(format!(
            "the key file {path} is missing or empty - start the server first"
        )));
    }
    write_key_file(&path, key)?;
    logger::info(
        "A server in the foreground loads the new key when you send it SIGHUP (kill -HUP <pid>), or when it starts again.",
    );
    Ok((path, old))
}

pub fn parse_hours(value: Option<&str>) -> Result<i64> {
    let choices = AGENT_KEY_HOURS
        .iter()
        .map(|hours| format!("{hours}h"))
        .collect::<Vec<_>>()
        .join(", ");
    let Some(value) = value else {
        return Err(Error::new(format!(
            "give the time of the agent key with --for, one of {choices}"
        )));
    };
    value
        .strip_suffix('h')
        .and_then(|number| number.parse::<i64>().ok())
        .filter(|hours| AGENT_KEY_HOURS.contains(hours) && !value.starts_with('+'))
        .ok_or_else(|| {
            Error::new(format!(
                "--for \"{value}\" is not a time of an agent key - use one of {choices} ({} hours)",
                hours_text()
            ))
        })
}

fn add_agent_key(parsed: &Parsed) -> Result<()> {
    require_only_flags(
        parsed,
        &["auth", "url", "server", "timeout", "for"],
        "key add",
    )?;
    let (Some(name), 3) = (parsed.positional.get(2), parsed.positional.len()) else {
        return Err(Error::new(USAGE));
    };
    let body: Value = Object::new()
        .with("name", name.as_str())
        .with("hours", parse_hours(parsed.get("for"))?)
        .into();
    let target = resolve_one(&selection(parsed))?;
    let timeout = parse_timeout(parsed.get("timeout"))?.unwrap_or(CALL_TIMEOUT_MS);
    let added = call_server(&target, "POST", "/keys", Some(&body), Some(timeout))?;
    let key = added.get_str("key").unwrap_or("");
    logger::plain(format!(
        "
  Agent key:  {key}
  Name:       {name}
  Expires:    {}
  Server:     {}

This key is for an AI agent that uses the imp-aly CLI. It has the rights of the
server key until it expires, but it cannot add, list or remove agent keys.
Give the agent this command, which saves the server under the name {name}:

  imp-aly add {name} {} -a {key}

Remove it earlier with: imp-aly key rm {name}{}
",
        added.get_str("expiresAt").unwrap_or(""),
        target.label,
        target.url,
        target
            .server
            .as_deref()
            .map_or_else(String::new, |server| format!(" -s {server}"))
    ));
    Ok(())
}

fn list_agent_keys(parsed: &Parsed) -> Result<()> {
    require_only_flags(
        parsed,
        &["auth", "url", "server", "timeout", "json"],
        "key ls",
    )?;
    if parsed.positional.len() > 2 {
        return Err(Error::new(USAGE));
    }
    let target = resolve_one(&selection(parsed))?;
    let timeout = parse_timeout(parsed.get("timeout"))?.unwrap_or(CALL_TIMEOUT_MS);
    let listed = call_server(&target, "GET", "/keys", None, Some(timeout))?;
    if parsed.has("json") {
        println!("{}", json::pretty(&listed));
        return Ok(());
    }
    let rows = listed
        .get("keys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        logger::plain(format!("{} has no agent keys.", target.label));
        return Ok(());
    }
    logger::plain(format_table(&["name", "createdAt", "expiresAt"], &rows));
    Ok(())
}

fn remove_agent_key(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth", "url", "server", "timeout"], "key rm")?;
    let (Some(name), 3) = (parsed.positional.get(2), parsed.positional.len()) else {
        return Err(Error::new(USAGE));
    };
    let target = resolve_one(&selection(parsed))?;
    let timeout = parse_timeout(parsed.get("timeout"))?.unwrap_or(CALL_TIMEOUT_MS);
    let path = format!("/keys/{}", encode_component(name));
    call_server(&target, "DELETE", &path, None, Some(timeout))?;
    logger::info(format!(
        "Removed the agent key \"{name}\" from {}. The server refuses it now.",
        target.label
    ));
    Ok(())
}

pub fn key(parsed: &Parsed) -> Result<()> {
    match parsed.positional.get(1).map(String::as_str) {
        Some("add") => return add_agent_key(parsed),
        Some("ls") => return list_agent_keys(parsed),
        Some("rm") => return remove_agent_key(parsed),
        Some("rotate") if parsed.positional.len() == 2 => {}
        _ => return Err(Error::new(USAGE)),
    }
    require_only_flags(parsed, &["auth"], "key rotate")?;
    let fresh = generate_key();
    let (key_path, old) = match read_unit() {
        None => rotate_key_file(&fresh, parsed.get("auth"))?,
        Some(unit) => rotate_service_key(&unit, &fresh, parsed.get("auth"))?,
    };
    if let Ok(store) = load_servers(&servers_path()) {
        for entry in store
            .servers
            .iter()
            .filter(|entry| entry.auth.as_deref() == Some(old.as_str()))
        {
            logger::warn(format!(
                "The saved server \"{}\" holds the old key - run: imp-aly add {} {} -a {key_path}",
                entry.name, entry.name, entry.url
            ));
        }
    }
    logger::plain(format!(
        "
  Key:       {fresh}
  Key file:  {key_path}

Give the new key to each machine that calls this server:

  imp-aly add <name> <admin address> -a <key file>

In the console, open Servers and use \"Change the URL or the key\" on this server.
The server removed all agent keys. Add new agent keys when the agents need them.
"
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_time_of_an_agent_key_is_one_of_the_fixed_hours() {
        assert_eq!(parse_hours(Some("1h")).unwrap(), 1);
        assert_eq!(parse_hours(Some("24h")).unwrap(), 24);
        for wrong in [
            None,
            Some(""),
            Some("h"),
            Some("4"),
            Some("2h"),
            Some("60m"),
            Some("+8h"),
        ] {
            assert!(parse_hours(wrong).is_err(), "{wrong:?}");
        }
    }
}
