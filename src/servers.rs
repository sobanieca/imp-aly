use crate::auth::resolve_key;
use crate::error::{Error, Result};
use crate::json::{self, Object, Value};
use crate::paths::{dirname, home, join};
use crate::service::{ServiceTarget, local_service};
use crate::url::Url;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::OpenOptionsExt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedServer {
    pub name: String,
    pub url: String,
    pub auth: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub servers: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Store {
    pub default: String,
    pub servers: Vec<SavedServer>,
    pub groups: Vec<Group>,
}

#[derive(Debug)]
pub enum Found {
    Server(SavedServer),
    Group(Group),
}

pub fn servers_path() -> String {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| join(&[&home(), ".config"]));
    join(&[&base, "imp-aly", "servers.json"])
}

fn is_server_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn read_store(path: &str) -> Result<Store> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Store::default()),
        Err(error) => return Err(Error::io(&error, path)),
    };
    let data = json::parse(&text)
        .map_err(|_| Error::new(format!("{path} is not valid JSON - fix it or delete it")))?;
    let servers = data
        .get("servers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(SavedServer {
                        name: item.get_str("name")?.to_string(),
                        url: item.get_str("url")?.to_string(),
                        auth: item.get_str("auth").map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let groups = data
        .get("groups")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(Group {
                        name: item.get_str("name")?.to_string(),
                        servers: strings(item.get("servers")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Store {
        default: data.get_str("default").unwrap_or("").to_string(),
        servers,
        groups,
    })
}

pub fn server_value(server: &SavedServer) -> Value {
    let mut object = Object::new()
        .with("name", server.name.clone())
        .with("url", server.url.clone());
    if let Some(auth) = &server.auth {
        object.insert("auth", auth.clone());
    }
    object.into()
}

pub fn group_value(group: &Group) -> Value {
    Object::new()
        .with("name", group.name.clone())
        .with("servers", group.servers.clone())
        .into()
}

pub fn store_value(store: &Store) -> Value {
    Object::new()
        .with("default", store.default.clone())
        .with(
            "servers",
            Value::Array(store.servers.iter().map(server_value).collect()),
        )
        .with(
            "groups",
            Value::Array(store.groups.iter().map(group_value).collect()),
        )
        .into()
}

fn write_store(path: &str, store: &Store) -> Result<()> {
    fs::create_dir_all(dirname(path)).map_err(|error| Error::io(&error, path))?;
    let temporary = format!("{path}.tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| Error::io(&error, &temporary))?;
    use std::io::Write;
    file.write_all(format!("{}\n", json::pretty(&store_value(store))).as_bytes())
        .map_err(|error| Error::io(&error, &temporary))?;
    fs::rename(&temporary, path).map_err(|error| Error::io(&error, path))
}

pub fn load_servers(path: &str) -> Result<Store> {
    read_store(path)
}

pub fn key_label(auth: Option<&str>) -> String {
    match auth {
        None | Some("") => "default key file".to_string(),
        Some(auth) if auth.starts_with('/') => auth.to_string(),
        Some(_) => "saved key".to_string(),
    }
}

pub fn parse_server_url(value: &str) -> Result<String> {
    let text = value.trim();
    let Some(url) = Url::parse(text) else {
        return Err(Error::new(format!(
            "\"{value}\" is not a server URL - use http(s)://host[:port]"
        )));
    };
    if url.has_search() || url.has_hash() || url.has_user() {
        return Err(Error::new(format!(
            "\"{value}\" must not have a query, a fragment or a user"
        )));
    }
    let mut url = url;
    url.query = None;
    url.fragment = None;
    Ok(url.href().trim_end_matches('/').to_string())
}

fn stored_auth(auth: Option<&str>) -> Result<Option<String>> {
    let Some(auth) = auth.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let resolved = resolve_key(Some(auth))?;
    Ok(Some(if resolved.path.is_empty() {
        resolved.key
    } else {
        resolved.path
    }))
}

fn check_name(name: &str, kind: &str) -> Result<()> {
    if !is_server_name(name) {
        return Err(Error::new(format!(
            "\"{name}\" is not a {kind} name - use letters, digits, \".\", \"_\" and \"-\", up to 63"
        )));
    }
    Ok(())
}

fn find_entry(store: &Store, name: &str) -> Result<Found> {
    if let Some(server) = store.servers.iter().find(|entry| entry.name == name) {
        return Ok(Found::Server(server.clone()));
    }
    if let Some(group) = store.groups.iter().find(|entry| entry.name == name) {
        return Ok(Found::Group(group.clone()));
    }
    Err(Error::new(format!(
        "no server or group named \"{name}\" - see imp-aly ls"
    )))
}

pub fn add_server(name: &str, url: &str, auth: Option<&str>, path: &str) -> Result<SavedServer> {
    check_name(name, "server")?;
    let server = SavedServer {
        name: name.to_string(),
        url: parse_server_url(url)?,
        auth: stored_auth(auth)?,
    };
    let mut store = read_store(path)?;
    if store.groups.iter().any(|entry| entry.name == name) {
        return Err(Error::new(format!(
            "\"{name}\" is a group - use another name, or remove the group first"
        )));
    }
    match store.servers.iter().position(|entry| entry.name == name) {
        Some(index) => store.servers[index] = server.clone(),
        None => store.servers.push(server.clone()),
    }
    store.default = name.to_string();
    write_store(path, &store)?;
    Ok(server)
}

pub fn server_names(value: &str) -> Result<Vec<String>> {
    let names: Vec<String> = value
        .split(',')
        .map(|name| name.trim().to_string())
        .collect();
    if names.iter().any(String::is_empty) {
        return Err(Error::new(format!(
            "\"{value}\" is not a list of server names - use a,b,c"
        )));
    }
    let mut unique = names.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != names.len() {
        return Err(Error::new(format!("\"{value}\" names a server twice")));
    }
    Ok(names)
}

pub fn add_group(name: &str, servers: &str, path: &str) -> Result<Group> {
    check_name(name, "group")?;
    let members = server_names(servers)?;
    let mut store = read_store(path)?;
    if store.servers.iter().any(|entry| entry.name == name) {
        return Err(Error::new(format!(
            "\"{name}\" is a saved server - use another name for the group"
        )));
    }
    for member in &members {
        if store.groups.iter().any(|entry| &entry.name == member) {
            return Err(Error::new(format!(
                "\"{member}\" is a group - a group holds servers, not groups"
            )));
        }
        if !store.servers.iter().any(|entry| &entry.name == member) {
            return Err(Error::new(format!(
                "no server named \"{member}\" - add it first with imp-aly add"
            )));
        }
    }
    let group = Group {
        name: name.to_string(),
        servers: members,
    };
    match store.groups.iter().position(|entry| entry.name == name) {
        Some(index) => store.groups[index] = group.clone(),
        None => store.groups.push(group.clone()),
    }
    write_store(path, &store)?;
    Ok(group)
}

pub fn remove_saved(name: &str, path: &str) -> Result<Found> {
    let mut store = read_store(path)?;
    let found = find_entry(&store, name)?;
    match &found {
        Found::Server(_) => {
            if let Some(holder) = store
                .groups
                .iter()
                .find(|entry| entry.servers.iter().any(|member| member == name))
            {
                return Err(Error::new(format!(
                    "\"{name}\" is in the group \"{}\" - change the group with imp-aly group, or remove the group first",
                    holder.name
                )));
            }
            store.servers.retain(|entry| entry.name != name);
        }
        Found::Group(_) => store.groups.retain(|entry| entry.name != name),
    }
    if store.default == name {
        store.default = store
            .servers
            .last()
            .map(|entry| entry.name.clone())
            .unwrap_or_default();
    }
    write_store(path, &store)?;
    Ok(found)
}

pub fn use_saved(name: &str, path: &str) -> Result<Found> {
    let mut store = read_store(path)?;
    let found = find_entry(&store, name)?;
    store.default = name.to_string();
    write_store(path, &store)?;
    Ok(found)
}

fn default_names(store: &Store) -> Vec<String> {
    let known = store
        .servers
        .iter()
        .any(|entry| entry.name == store.default)
        || store.groups.iter().any(|entry| entry.name == store.default);
    if known {
        vec![store.default.clone()]
    } else {
        Vec::new()
    }
}

fn expand_name(store: &Store, name: &str) -> Result<Vec<SavedServer>> {
    match find_entry(store, name)? {
        Found::Server(server) => Ok(vec![server]),
        Found::Group(group) => group
            .servers
            .iter()
            .map(|member| {
                store
                    .servers
                    .iter()
                    .find(|entry| &entry.name == member)
                    .cloned()
                    .ok_or_else(|| {
                        Error::new(format!(
                            "the group \"{name}\" names \"{member}\", which is not a saved server"
                        ))
                    })
            })
            .collect(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub url: Option<String>,
    pub auth: Option<String>,
    pub server: Option<String>,
    pub service: bool,
}

pub struct Selection<'a> {
    pub url: Option<&'a str>,
    pub auth: Option<&'a str>,
    pub server: Option<&'a str>,
}

pub type LocalService = dyn Fn() -> Option<ServiceTarget>;

pub fn resolve_targets_with(
    selection: &Selection,
    path: &str,
    local: &LocalService,
) -> Result<Vec<Target>> {
    if selection.url.is_some() && selection.server.is_some() {
        return Err(Error::new("give --server or --url, not both"));
    }
    let auth = selection.auth.map(str::to_string);
    if let Some(url) = selection.url {
        return Ok(vec![Target {
            url: Some(parse_server_url(url)?),
            auth,
            server: None,
            service: false,
        }]);
    }
    let store = read_store(path)?;
    let names = match selection.server {
        None => default_names(&store),
        Some(value) => server_names(value)?,
    };
    let mut saved = Vec::new();
    for name in &names {
        saved.extend(expand_name(&store, name)?);
    }
    if saved.is_empty() {
        return Ok(vec![match local() {
            None => Target {
                url: None,
                auth,
                server: None,
                service: false,
            },
            Some(service) => Target {
                url: Some(service.url),
                auth: auth.or(Some(service.key_path)),
                server: None,
                service: true,
            },
        }]);
    }
    for (index, entry) in saved.iter().enumerate() {
        if saved[..index].iter().any(|other| other.name == entry.name) {
            return Err(Error::new(format!(
                "\"{}\" names the server \"{}\" twice",
                selection.server.unwrap_or(&store.default),
                entry.name
            )));
        }
    }
    Ok(saved
        .into_iter()
        .map(|entry| Target {
            url: Some(entry.url),
            auth: auth.clone().or(entry.auth),
            server: Some(entry.name),
            service: false,
        })
        .collect())
}

pub fn resolve_targets(selection: &Selection) -> Result<Vec<Target>> {
    resolve_targets_with(selection, &servers_path(), &local_service)
}

pub fn resolve_target_with(
    selection: &Selection,
    path: &str,
    local: &LocalService,
) -> Result<Target> {
    let one_server = || {
        Error::new(format!(
            "this command takes one server, not \"{}\"",
            selection.server.unwrap_or("")
        ))
    };
    if let Some(server) = selection.server
        && server_names(server)?.len() > 1
    {
        return Err(one_server());
    }
    let mut targets = resolve_targets_with(selection, path, local)?;
    if targets.len() == 1 {
        return Ok(targets.remove(0));
    }
    if selection.server.is_some() {
        return Err(one_server());
    }
    Err(Error::new(format!(
        "the default \"{}\" is a group - this command takes one server, use -s <name>",
        read_store(path)?.default
    )))
}

pub fn resolve_target(selection: &Selection) -> Result<Target> {
    resolve_target_with(selection, &servers_path(), &local_service)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn none() -> Option<ServiceTarget> {
        None
    }

    fn select<'a>(url: Option<&'a str>, server: Option<&'a str>) -> Selection<'a> {
        Selection {
            url,
            auth: None,
            server,
        }
    }

    #[test]
    fn a_saved_server_keeps_its_url_and_its_key_and_becomes_the_default() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        let saved = add_server(
            "eu",
            "https://eu.example:2981/",
            Some("plain-key-0123456789"),
            &path,
        )
        .unwrap();
        assert_eq!(saved.url, "https://eu.example:2981");
        assert_eq!(saved.auth.as_deref(), Some("plain-key-0123456789"));
        add_server("us", "http://203.0.113.10:2981", Some("/keys/us"), &path).unwrap();
        let store = read_store(&path).unwrap();
        assert_eq!(store.default, "us");
        assert_eq!(store.servers.len(), 2);
        assert_eq!(key_label(Some("/keys/us")), "/keys/us");
        assert_eq!(key_label(Some("abc")), "saved key");
        assert_eq!(key_label(None), "default key file");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn use_changes_the_default_and_rm_picks_another_default() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        add_server("eu", "https://eu.example", None, &path).unwrap();
        add_server("us", "https://us.example", None, &path).unwrap();
        use_saved("eu", &path).unwrap();
        assert_eq!(read_store(&path).unwrap().default, "eu");
        remove_saved("eu", &path).unwrap();
        assert_eq!(read_store(&path).unwrap().default, "us");
        assert!(remove_saved("nope", &path).is_err());
    }

    #[test]
    fn server_names_and_urls_are_checked() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        assert!(add_server("-bad", "https://a.example", None, &path).is_err());
        assert!(add_server("ok", "ftp://a.example", None, &path).is_err());
        assert!(add_server("ok", "https://a.example/?x=1", None, &path).is_err());
        assert!(add_server("ok", "https://user@a.example", None, &path).is_err());
    }

    #[test]
    fn the_target_comes_from_the_url_the_server_or_the_default_server() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        let target = resolve_target_with(&select(None, None), &path, &none).unwrap();
        assert_eq!(target.url, None);
        add_server("eu", "https://eu.example", Some("/keys/eu"), &path).unwrap();
        add_server("us", "https://us.example", None, &path).unwrap();
        let target = resolve_target_with(&select(None, Some("eu")), &path, &none).unwrap();
        assert_eq!(
            (target.url.as_deref(), target.auth.as_deref()),
            (Some("https://eu.example"), Some("/keys/eu"))
        );
        let target =
            resolve_target_with(&select(Some("http://127.0.0.1:2981/"), None), &path, &none)
                .unwrap();
        assert_eq!(target.url.as_deref(), Some("http://127.0.0.1:2981"));
        assert!(resolve_target_with(&select(Some("http://a"), Some("eu")), &path, &none).is_err());
        let default = resolve_target_with(&select(None, None), &path, &none).unwrap();
        assert_eq!(default.server.as_deref(), Some("us"));
    }

    #[test]
    fn a_broken_servers_file_is_an_error() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        fs::write(&path, "{broken").unwrap();
        assert!(
            read_store(&path)
                .unwrap_err()
                .message
                .contains("not valid JSON")
        );
    }

    #[test]
    fn a_group_names_saved_servers_and_a_single_server_command_refuses_it() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        add_server("eu", "https://eu.example", None, &path).unwrap();
        add_server("us", "https://us.example", None, &path).unwrap();
        assert!(add_group("all", "eu,nope", &path).is_err());
        assert!(add_group("eu", "us", &path).is_err());
        add_group("all", "eu,us", &path).unwrap();
        assert!(add_group("more", "all", &path).is_err());
        assert!(add_server("all", "https://x.example", None, &path).is_err());
        let targets = resolve_targets_with(&select(None, Some("all")), &path, &none).unwrap();
        assert_eq!(targets.len(), 2);
        assert!(resolve_targets_with(&select(None, Some("all,eu")), &path, &none).is_err());
        assert!(resolve_target_with(&select(None, Some("eu,us")), &path, &none).is_err());
        use_saved("all", &path).unwrap();
        assert!(
            resolve_target_with(&select(None, None), &path, &none)
                .unwrap_err()
                .message
                .contains("is a group")
        );
        assert!(
            remove_saved("eu", &path)
                .unwrap_err()
                .message
                .contains("is in the group")
        );
        remove_saved("all", &path).unwrap();
        assert!(server_names("a,,b").is_err());
        assert!(server_names("a,a").is_err());
    }

    #[test]
    fn with_no_saved_server_the_client_calls_the_local_service_with_its_key_file() {
        let dir = TempDir::new();
        let path = dir.join("servers.json");
        let local = || {
            Some(ServiceTarget {
                url: "http://127.0.0.1:2981".to_string(),
                key_path: "/root/.secret/imp-aly-key".to_string(),
            })
        };
        let target = resolve_target_with(&select(None, None), &path, &local).unwrap();
        assert!(target.service);
        assert_eq!(target.auth.as_deref(), Some("/root/.secret/imp-aly-key"));
    }
}
