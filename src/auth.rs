use crate::days::{iso, now_ms};
use crate::error::{Error, Result};
use crate::logger;
use crate::paths::{absolute_path, dirname, home, join};
use crate::token::random_bytes;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

const KEY_LENGTH: usize = 32;

const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

pub const NEW_KEY_FILE: &str = "new-key";

pub const KEY_LOADED_FILE: &str = "key-loaded";

const HANDOVER_DIR_MODE: u32 = 0o750;

const HANDOVER_FILE_MODE: u32 = 0o640;

pub fn generate_key() -> String {
    loop {
        let usable: Vec<u8> = random_bytes(KEY_LENGTH * 2)
            .into_iter()
            .filter(|byte| *byte < 248)
            .collect();
        if usable.len() >= KEY_LENGTH {
            return usable[..KEY_LENGTH]
                .iter()
                .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
                .collect();
        }
    }
}

pub fn default_key_path() -> String {
    join(&[&home(), ".secret", "imp-aly-key"])
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.starts_with('~') || value.starts_with('.')
}

fn os_reason(error: &std::io::Error) -> String {
    error.to_string()
}

fn is_file(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

pub fn read_key_file(path: &str) -> Result<String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text.trim().to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(Error::new(format!(
            "cannot read the key file {path} ({})",
            os_reason(&error)
        ))),
    }
}

pub fn remove_file(path: &str) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::io(&error, path)),
    }
}

pub fn write_key_file_with(
    path: &str,
    key: &str,
    mode: u32,
    before_rename: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    let temporary = format!("{path}.tmp");
    remove_file(&temporary)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)
        .map_err(|error| Error::io(&error, &temporary))?;
    file.write_all(format!("{key}\n").as_bytes())
        .map_err(|error| Error::io(&error, &temporary))?;
    drop(file);
    before_rename(&temporary)?;
    fs::rename(&temporary, path).map_err(|error| Error::io(&error, path))
}

pub fn write_key_file(path: &str, key: &str) -> Result<()> {
    write_key_file_with(path, key, 0o600, |_| Ok(()))
}

fn chown(path: &str, uid: u32, gid: u32) -> Result<()> {
    std::os::unix::fs::chown(path, Some(uid), Some(gid)).map_err(|error| Error::io(&error, path))
}

fn chmod(path: &str, mode: u32) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| Error::io(&error, path))
}

fn prepare_handover_dir(dir: &str, uid: u32, gid: u32) -> Result<()> {
    match fs::DirBuilder::new().mode(HANDOVER_DIR_MODE).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(Error::io(&error, dir)),
    }
    let info = fs::symlink_metadata(dir).map_err(|error| Error::io(&error, dir))?;
    if !info.is_dir() || info.uid() != uid {
        return Err(Error::new(format!(
            "{dir} must be a folder of the user {uid} - remove it, then try again"
        )));
    }
    chown(dir, uid, gid)?;
    chmod(dir, HANDOVER_DIR_MODE)
}

pub fn hand_over_key(dir: &str, key: &str, uid: u32, gid: u32) -> Result<String> {
    prepare_handover_dir(dir, uid, gid)?;
    let path = join(&[dir, NEW_KEY_FILE]);
    write_key_file_with(&path, key, HANDOVER_FILE_MODE, |temporary| {
        chown(temporary, uid, gid)?;
        chmod(temporary, HANDOVER_FILE_MODE)
    })?;
    Ok(path)
}

pub fn take_new_key(
    handover_dir: &str,
    data_dir: &str,
    apply: impl FnOnce(&str) -> Result<()>,
) -> Result<String> {
    let key = read_key_file(&join(&[handover_dir, NEW_KEY_FILE]))?;
    if key.is_empty() {
        return Ok(String::new());
    }
    apply(&key)?;
    let loaded = join(&[data_dir, KEY_LOADED_FILE]);
    fs::write(&loaded, format!("{}\n", iso(now_ms())))
        .map_err(|error| Error::io(&error, &loaded))?;
    Ok(key)
}

pub struct Resolved {
    pub key: String,
    pub path: String,
}

pub fn resolve_key(auth: Option<&str>) -> Result<Resolved> {
    let value = auth.unwrap_or("").trim();
    if value.is_empty() {
        let path = default_key_path();
        return Ok(Resolved {
            key: read_key_file(&path)?,
            path,
        });
    }
    if looks_like_path(value) {
        let path = absolute_path(value);
        return Ok(Resolved {
            key: read_key_file(&path)?,
            path,
        });
    }
    if is_file(value) {
        return Ok(Resolved {
            key: read_key_file(value)?,
            path: absolute_path(value),
        });
    }
    Ok(Resolved {
        key: value.to_string(),
        path: String::new(),
    })
}

pub fn find_key(auth: Option<&str>) -> Result<String> {
    let Resolved { key, path } = resolve_key(auth)?;
    if key.is_empty() {
        return Err(Error::new(format!(
            "the key file {path} is missing or empty - save the key that the server prints there, or pass -a <key>"
        )));
    }
    Ok(key)
}

pub fn find_or_create_key(auth: Option<&str>, default_path: &str) -> Result<Resolved> {
    let Resolved { key, path } = resolve_key(auth)?;
    let target = if path.is_empty() {
        default_path.to_string()
    } else {
        path
    };
    let saved = read_key_file(&target)?;
    if !key.is_empty() && key == saved {
        return Ok(Resolved { key, path: target });
    }
    if !key.is_empty() && !saved.is_empty() {
        return Err(Error::new(format!(
            "the key file {target} holds a different key - pass -a {target}, or remove the file to save the new key"
        )));
    }
    let fresh = if key.is_empty() { generate_key() } else { key };
    fs::create_dir_all(dirname(&target))
        .map_err(Error::from)
        .and_then(|()| write_key_file(&target, &fresh))
        .map_err(|error| {
            Error::new(format!(
                "cannot save the key to {target} ({}) - pass -a <file> with a path that you can write",
                error.message.split(": ").next().unwrap_or(&error.message)
            ))
        })?;
    logger::info(format!("Key saved to {target}"));
    Ok(Resolved {
        key: fresh,
        path: target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn a_key_has_32_letters_and_digits() {
        let key = generate_key();
        assert_eq!(key.len(), 32);
        assert!(key.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        assert_ne!(key, generate_key());
    }

    #[test]
    fn the_key_comes_from_a_file_or_from_the_value() {
        let dir = TempDir::new();
        let path = dir.join("key");
        write_key_file(&path, "from-file-0123456789").unwrap();
        assert_eq!(find_key(Some(&path)).unwrap(), "from-file-0123456789");
        assert_eq!(
            find_key(Some("plain-key-0123456789")).unwrap(),
            "plain-key-0123456789"
        );
        let missing = dir.join("missing");
        assert!(
            find_key(Some(&missing))
                .unwrap_err()
                .message
                .contains("missing or empty")
        );
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn the_server_saves_a_key_as_text_only_when_the_key_file_is_empty() {
        let dir = TempDir::new();
        let path = dir.join("nested/key");
        let created = find_or_create_key(Some(&path), &path).unwrap();
        assert_eq!(read_key_file(&path).unwrap(), created.key);
        let again = find_or_create_key(Some(&path), &path).unwrap();
        assert_eq!(again.key, created.key);
        let other = dir.join("other");
        write_key_file(&other, "first-key-0123456789").unwrap();
        let error = find_or_create_key(Some("second-key-0123456789"), &other);
        assert!(error.is_err());
    }

    #[test]
    fn the_service_takes_the_handed_over_key_and_writes_the_loaded_mark() {
        let dir = TempDir::new();
        let handover = dir.join("run");
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let path = hand_over_key(&handover, "handed-key-0123456789", uid, gid).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, HANDOVER_FILE_MODE);
        let mut applied = String::new();
        let key = take_new_key(&handover, &data, |key| {
            applied = key.to_string();
            Ok(())
        })
        .unwrap();
        assert_eq!(key, "handed-key-0123456789");
        assert_eq!(applied, key);
        assert!(fs::metadata(&path).is_ok());
        assert!(fs::metadata(join(&[&data, KEY_LOADED_FILE])).is_ok());
    }
}
