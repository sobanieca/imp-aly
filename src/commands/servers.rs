use crate::args::{Parsed, require_only_flags};
use crate::error::{Error, Result};
use crate::json::{self, Object, Value};
use crate::logger;
use crate::servers::{
    Found, add_group, add_server, key_label, load_servers, remove_saved, servers_path, store_value,
    use_saved as select_saved,
};
use crate::table::format_table;

pub fn add(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth"], "add")?;
    let (Some(name), Some(url), 3) = (
        parsed.positional.get(1),
        parsed.positional.get(2),
        parsed.positional.len(),
    ) else {
        return Err(Error::new(
            "use: imp-aly add <name> <url> [-a <key or file>]",
        ));
    };
    let path = servers_path();
    let saved = add_server(name, url, parsed.get("auth"), &path)?;
    logger::plain(format!(
        "Saved server \"{}\": {}, key: {}",
        saved.name,
        saved.url,
        key_label(saved.auth.as_deref())
    ));
    logger::plain(format!("It is the default server now. Saved in {path}"));
    Ok(())
}

pub fn group(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &[], "group")?;
    let (Some(name), Some(servers), 3) = (
        parsed.positional.get(1),
        parsed.positional.get(2),
        parsed.positional.len(),
    ) else {
        return Err(Error::new("use: imp-aly group <name> <a,b,c>"));
    };
    let path = servers_path();
    let saved = add_group(name, servers, &path)?;
    logger::plain(format!(
        "Saved group \"{}\": {}",
        saved.name,
        saved.servers.join(", ")
    ));
    if load_servers(&path)?.default != saved.name {
        logger::plain(format!(
            "Make it the default with: imp-aly use {}",
            saved.name
        ));
    }
    Ok(())
}

pub fn ls(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["json"], "ls")?;
    if parsed.positional.len() > 1 {
        return Err(Error::new("use: imp-aly ls [--json]"));
    }
    let store = load_servers(&servers_path())?;
    if parsed.has("json") {
        let mut value = store_value(&store);
        if let Value::Object(object) = &mut value {
            let servers: Vec<Value> = store
                .servers
                .iter()
                .map(|entry| {
                    Object::new()
                        .with("name", entry.name.clone())
                        .with("url", entry.url.clone())
                        .with("auth", key_label(entry.auth.as_deref()))
                        .into()
                })
                .collect();
            object.insert("servers", Value::Array(servers));
        }
        println!("{}", json::pretty(&value));
        return Ok(());
    }
    if store.servers.is_empty() {
        logger::plain("No server is saved. Add one with: imp-aly add <name> <url>");
        return Ok(());
    }
    let mark = |name: &str| if name == store.default { "*" } else { "" };
    let rows: Vec<Value> = store
        .servers
        .iter()
        .map(|entry| {
            Object::new()
                .with("default", mark(&entry.name))
                .with("name", entry.name.clone())
                .with("url", entry.url.clone())
                .with("key", key_label(entry.auth.as_deref()))
                .into()
        })
        .collect();
    logger::plain(format_table(&["default", "name", "url", "key"], &rows));
    if store.groups.is_empty() {
        return Ok(());
    }
    logger::plain("");
    let rows: Vec<Value> = store
        .groups
        .iter()
        .map(|entry| {
            Object::new()
                .with("default", mark(&entry.name))
                .with("group", entry.name.clone())
                .with("servers", entry.servers.join(","))
                .into()
        })
        .collect();
    logger::plain(format_table(&["default", "group", "servers"], &rows));
    Ok(())
}

fn read_name<'a>(parsed: &'a Parsed, command: &str) -> Result<&'a str> {
    require_only_flags(parsed, &[], command)?;
    match (parsed.positional.get(1), parsed.positional.len()) {
        (Some(name), 2) => Ok(name),
        _ => Err(Error::new(format!("use: imp-aly {command} <name>"))),
    }
}

fn describe(found: &Found) -> String {
    match found {
        Found::Server(server) => format!("server \"{}\" ({})", server.name, server.url),
        Found::Group(group) => format!("group \"{}\" ({})", group.name, group.servers.join(", ")),
    }
}

pub fn use_saved(parsed: &Parsed) -> Result<()> {
    let found = select_saved(read_name(parsed, "use")?, &servers_path())?;
    logger::plain(format!("The {} is the default now", describe(&found)));
    Ok(())
}

pub fn rm(parsed: &Parsed) -> Result<()> {
    let path = servers_path();
    let removed = remove_saved(read_name(parsed, "rm")?, &path)?;
    let next = load_servers(&path)?.default;
    logger::plain(format!("Removed {}", describe(&removed)));
    if !next.is_empty() {
        logger::plain(format!("The default is \"{next}\""));
    }
    Ok(())
}
