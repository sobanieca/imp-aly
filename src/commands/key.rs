use crate::args::{Parsed, require_only_flags};
use crate::auth::{generate_key, read_key_file, resolve_key, write_key_file};
use crate::error::{Error, Result};
use crate::logger;
use crate::servers::{load_servers, servers_path};
use crate::service::{
    SERVICE_NAME, is_active, is_root, read_unit, send_key_to_service, unit_settings,
};

const USAGE: &str = "use: imp-aly key rotate [-a <key file>]";

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

pub fn key(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth"], "key")?;
    if parsed.positional.get(1).map(String::as_str) != Some("rotate") || parsed.positional.len() > 2
    {
        return Err(Error::new(USAGE));
    }
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
"
    ));
    Ok(())
}
