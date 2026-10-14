use crate::error::{Error, Result};
use crate::json::{self, Value};
use crate::paths::dirname;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};

pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_file: bool,
}

pub fn sync_directory(path: &str) -> Result<()> {
    let directory = File::open(path).map_err(|error| Error::io(&error, path))?;
    directory
        .sync_all()
        .map_err(|error| Error::io(&error, path))
}

pub fn write_file_atomic(path: &str, bytes: &[u8]) -> Result<()> {
    let temporary = format!("{path}.tmp");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| Error::io(&error, &temporary))?;
        file.write_all(bytes)
            .map_err(|error| Error::io(&error, &temporary))?;
        file.sync_data()
            .map_err(|error| Error::io(&error, &temporary))?;
    }
    fs::rename(&temporary, path).map_err(|error| Error::io(&error, path))?;
    sync_directory(&dirname(path))
}

pub fn write_json_atomic(path: &str, value: &Value) -> Result<()> {
    write_file_atomic(path, format!("{}\n", json::pretty(value)).as_bytes())
}

pub fn read_text(path: &str) -> Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| Error::new(format!("{path} is not UTF-8 text"))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::io(&error, path)),
    }
}

pub fn read_json(path: &str) -> Result<Option<Value>> {
    match read_text(path)? {
        None => Ok(None),
        Some(text) => json::parse(&text)
            .map(Some)
            .map_err(|error| Error::new(format!("{error}: {path}"))),
    }
}

pub fn read_string(path: &str) -> Result<String> {
    match fs::read(path) {
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| Error::new(format!("{path} is not UTF-8 text")))
        }
        Err(error) => Err(Error::io(&error, path)),
    }
}

pub fn remove_if_exists(path: &str) -> Result<bool> {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(Error::io(&error, path)),
    };
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(Error::io(&error, path)),
    }
}

pub fn list_directory(path: &str) -> Result<Vec<Entry>> {
    let reader = match fs::read_dir(path) {
        Ok(reader) => reader,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(Error::io(&error, path)),
    };
    let mut entries = Vec::new();
    for entry in reader {
        let entry = entry.map_err(|error| Error::io(&error, path))?;
        let kind = entry.file_type().map_err(|error| Error::io(&error, path))?;
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: kind.is_dir(),
            is_file: kind.is_file(),
        });
    }
    Ok(entries)
}

pub fn create_dir_all(path: &str) -> Result<()> {
    fs::create_dir_all(path).map_err(|error| Error::io(&error, path))
}

pub fn exists(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn rename(from: &str, to: &str) -> Result<()> {
    fs::rename(from, to).map_err(|error| Error::io(&error, from))
}
