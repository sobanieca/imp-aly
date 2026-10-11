use crate::days::is_day;
use crate::error::{Error, Result};
use crate::fsutil::{
    create_dir_all, list_directory, read_json, read_string, remove_if_exists, rename,
    sync_directory, write_file_atomic, write_json_atomic,
};
use crate::json::{Object, Value, pretty};
use crate::line_files::{NullValues, RunReader, ValueReader, ValueSource, write_synced_lines};
use crate::names::{BASE_COLUMNS, is_app_name, is_source};
use crate::paths::join;
use crate::rle::{Cell, decode_runs, encode_value, split_lines};
use crate::seal_sort::{SEAL_CHUNK_ROWS, sort_day};
use crate::summary::{SUMMARY_KINDS, SummaryBuilder, summary_file};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};

pub const COMMIT_FILE: &str = "commit.json";

pub const SEALED_META_FILE: &str = "meta.json";

pub const SORT_COLUMNS: [&str; 5] = ["page", "type", "zone", "name", "visit"];

pub const SUMMARY_ONLY_PROBLEM: &str = "only the daily summary of the day is stored";

const READ_ATTEMPTS: u32 = 5;

pub fn apps_dir(data_dir: &str) -> String {
    join(&[data_dir, "apps"])
}

pub fn app_dir(data_dir: &str, app: &str) -> String {
    join(&[data_dir, "apps", app])
}

pub fn day_dir(data_dir: &str, app: &str, day: &str) -> String {
    join(&[data_dir, "apps", app, day])
}

pub fn source_dir(data_dir: &str, app: &str, day: &str, source: &str) -> String {
    join(&[data_dir, "apps", app, day, source])
}

pub fn order_columns<'a>(columns: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let unique: BTreeSet<&str> = columns.into_iter().collect();
    let mut ordered: Vec<String> = BASE_COLUMNS
        .iter()
        .filter(|column| unique.contains(*column))
        .map(|column| column.to_string())
        .collect();
    for column in &unique {
        if !BASE_COLUMNS.contains(column) {
            ordered.push(column.to_string());
        }
    }
    ordered
}

fn sorted_dirs(path: &str, keep: impl Fn(&str) -> bool) -> Result<Vec<String>> {
    let mut names: Vec<String> = list_directory(path)?
        .into_iter()
        .filter(|entry| entry.is_dir && keep(&entry.name))
        .map(|entry| entry.name)
        .collect();
    names.sort();
    Ok(names)
}

pub fn list_apps(data_dir: &str) -> Result<Vec<String>> {
    sorted_dirs(&apps_dir(data_dir), is_app_name)
}

pub fn list_days(data_dir: &str, app: &str) -> Result<Vec<String>> {
    sorted_dirs(&app_dir(data_dir, app), is_day)
}

pub fn list_sources_in(path: &str) -> Result<Vec<String>> {
    sorted_dirs(path, is_source)
}

pub fn list_sources(data_dir: &str, app: &str, day: &str) -> Result<Vec<String>> {
    list_sources_in(&day_dir(data_dir, app, day))
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Generations {
    pub sealed: u64,
    pub raws: Vec<u64>,
    pub stale_sealed: Vec<u64>,
    pub stale_raws: Vec<u64>,
    pub temporary: Vec<String>,
}

fn generation_of(name: &str) -> Option<(bool, u64)> {
    let (kind, number) = name.split_once('-')?;
    if number.is_empty() || number.len() > 15 || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number = number.parse().ok()?;
    match kind {
        "sealed" => Some((true, number)),
        "raw" => Some((false, number)),
        _ => None,
    }
}

pub fn read_generations(path: &str) -> Result<Generations> {
    let mut sealed_all = Vec::new();
    let mut raw_all = Vec::new();
    let mut temporary = Vec::new();
    for entry in list_directory(path)? {
        if !entry.is_dir {
            continue;
        }
        if entry.name.ends_with(".tmp") {
            temporary.push(entry.name);
            continue;
        }
        match generation_of(&entry.name) {
            Some((true, number)) => sealed_all.push(number),
            Some((false, number)) => raw_all.push(number),
            None => {}
        }
    }
    let sealed = sealed_all.iter().copied().max().unwrap_or(0);
    let mut raws: Vec<u64> = raw_all.iter().copied().filter(|g| *g > sealed).collect();
    raws.sort_unstable();
    Ok(Generations {
        sealed,
        raws,
        stale_sealed: sealed_all.into_iter().filter(|g| *g < sealed).collect(),
        stale_raws: raw_all.into_iter().filter(|g| *g <= sealed).collect(),
        temporary,
    })
}

pub struct AppendTarget {
    pub dir: String,
    pub applied_wal: u64,
}

pub fn append_target(path: &str) -> Result<Option<AppendTarget>> {
    let generations = read_generations(path)?;
    let meta = if generations.sealed > 0 {
        Some(read_sealed_meta(&join(&[
            path,
            &format!("sealed-{}", generations.sealed),
        ]))?)
    } else {
        None
    };
    if meta.as_ref().is_some_and(SealedMeta::summary_only) {
        return Ok(None);
    }
    let generation = generations
        .raws
        .last()
        .copied()
        .unwrap_or(generations.sealed + 1);
    Ok(Some(AppendTarget {
        dir: join(&[path, &format!("raw-{generation}")]),
        applied_wal: meta.map_or(0, |meta| meta.wal),
    }))
}

#[derive(Clone, Debug, Default)]
pub struct Commit {
    pub rows: u64,
    pub wal: u64,
    pub columns: Vec<(String, u64)>,
}

impl Commit {
    fn size_of(&self, column: &str) -> Option<u64> {
        self.columns
            .iter()
            .find(|(name, _)| name == column)
            .map(|(_, size)| *size)
    }
}

fn count_of(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_safe_integer)
        .and_then(|number| u64::try_from(number).ok())
}

pub fn read_commit(dir: &str) -> Result<Commit> {
    let path = join(&[dir, COMMIT_FILE]);
    let Some(value) = read_json(&path)? else {
        return Ok(Commit::default());
    };
    let invalid = || Error::new(format!("{path} is not a valid commit"));
    let rows = count_of(value.get("rows")).ok_or_else(invalid)?;
    let wal = count_of(value.get("wal")).ok_or_else(invalid)?;
    let Some(Value::Object(columns)) = value.get("columns") else {
        return Err(invalid());
    };
    let mut sizes = Vec::new();
    for (name, size) in columns.iter() {
        sizes.push((name.clone(), count_of(Some(size)).ok_or_else(invalid)?));
    }
    Ok(Commit {
        rows,
        wal,
        columns: sizes,
    })
}

fn column_path(dir: &str, column: &str) -> String {
    join(&[dir, &format!("{column}.txt")])
}

pub fn append_records(
    dir: &str,
    segment: u64,
    records: &[Object],
    applied_wal: u64,
) -> Result<bool> {
    create_dir_all(dir)?;
    let commit = read_commit(dir)?;
    if commit.wal.max(applied_wal) >= segment {
        return Ok(false);
    }
    let mut keys: Vec<&str> = commit
        .columns
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    for record in records {
        keys.extend(record.keys().map(String::as_str));
    }
    let columns = order_columns(keys);
    let mut opened: Vec<(String, Option<u64>)> = Vec::new();
    let mut sizes = Object::new();
    let result = (|| -> Result<()> {
        for column in &columns {
            let committed = commit.size_of(column);
            let path = column_path(dir, column);
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .map_err(|error| Error::io(&error, &path))?;
            opened.push((column.clone(), committed));
            file.set_len(committed.unwrap_or(0))
                .map_err(|error| Error::io(&error, &path))?;
            file.seek(SeekFrom::End(0))
                .map_err(|error| Error::io(&error, &path))?;
            let mut text = String::new();
            if committed.is_none() {
                text.push_str(&"\n".repeat(commit.rows as usize));
            }
            for record in records {
                let value = match record.get(column) {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Number(number)) => crate::json::format_number(*number),
                    _ => String::new(),
                };
                text.push_str(encode_value(Some(&value)));
                text.push('\n');
            }
            file.write_all(text.as_bytes())
                .map_err(|error| Error::io(&error, &path))?;
            file.sync_data().map_err(|error| Error::io(&error, &path))?;
            sizes.insert(column.clone(), committed.unwrap_or(0) + text.len() as u64);
        }
        write_json_atomic(
            &join(&[dir, COMMIT_FILE]),
            &Object::new()
                .with("rows", commit.rows + records.len() as u64)
                .with("wal", segment)
                .with("columns", sizes.clone())
                .into(),
        )
    })();
    if let Err(error) = result {
        revert_append(dir, &opened);
        return Err(error);
    }
    Ok(true)
}

fn revert_append(dir: &str, opened: &[(String, Option<u64>)]) {
    for (column, committed) in opened {
        let path = column_path(dir, column);
        let _ = match committed {
            None => remove_if_exists(&path).map(|_| ()),
            Some(size) => OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_len(*size))
                .map_err(Error::from),
        };
    }
}

#[derive(Clone, Debug)]
pub struct SealedMeta {
    pub rows: u64,
    pub wal: u64,
    pub columns: Vec<String>,
    pub plain: Vec<String>,
    pub raw: Object,
}

impl SealedMeta {
    pub fn summary(&self) -> bool {
        self.raw.get("summary") == Some(&Value::Bool(true))
    }

    pub fn summary_only(&self) -> bool {
        self.raw.get("summaryOnly") == Some(&Value::Bool(true))
    }

    pub fn days(&self) -> Option<&Value> {
        self.raw.get("days")
    }
}

fn read_strings(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
    )
}

pub fn read_sealed_meta(dir: &str) -> Result<SealedMeta> {
    let path = join(&[dir, SEALED_META_FILE]);
    let Some(value) = read_json(&path)? else {
        return Err(Error::missing(format!("{path} is missing")));
    };
    let invalid = || Error::new(format!("{path} is not valid"));
    let Value::Object(raw) = value else {
        return Err(invalid());
    };
    let rows = count_of(raw.get("rows")).ok_or_else(invalid)?;
    let wal = count_of(raw.get("wal")).ok_or_else(invalid)?;
    let columns = read_strings(raw.get("columns")).ok_or_else(invalid)?;
    let plain = read_strings(raw.get("plain")).ok_or_else(invalid)?;
    Ok(SealedMeta {
        rows,
        wal,
        columns,
        plain,
        raw,
    })
}

pub enum PartKind {
    Raw { dir: String, commit: Commit },
    Sealed { dir: String, meta: SealedMeta },
}

pub struct Part {
    pub rows: u64,
    pub wal: u64,
    pub columns: Vec<String>,
    pub kind: PartKind,
}

impl Part {
    pub fn read(&self, column: &str) -> Result<Vec<Cell>> {
        match &self.kind {
            PartKind::Raw { dir, commit } => {
                let Some(bytes) = commit.size_of(column) else {
                    return Ok(vec![None; commit.rows as usize]);
                };
                let path = column_path(dir, column);
                let data = fs::read(&path).map_err(|error| Error::io(&error, &path))?;
                if (data.len() as u64) < bytes {
                    return Err(Error::new(format!("{path} is shorter than its commit")));
                }
                let text = String::from_utf8_lossy(&data[..bytes as usize]);
                let values = split_lines(&text)?;
                if values.len() as u64 != commit.rows {
                    return Err(Error::new(format!(
                        "{path} holds {} rows, expected {}",
                        values.len(),
                        commit.rows
                    )));
                }
                Ok(values)
            }
            PartKind::Sealed { dir, meta } => {
                if meta.summary_only() {
                    return Err(Error::new(SUMMARY_ONLY_PROBLEM));
                }
                if !meta.columns.iter().any(|name| name == column) {
                    return Ok(vec![None; meta.rows as usize]);
                }
                if !meta.plain.iter().any(|name| name == column) {
                    let path = join(&[dir, &format!("{column}.rle")]);
                    return decode_runs(&read_string(&path)?, meta.rows);
                }
                let path = column_path(dir, column);
                let values = split_lines(&read_string(&path)?)?;
                if values.len() as u64 != meta.rows {
                    return Err(Error::new(format!(
                        "{path} holds {} rows, expected {}",
                        values.len(),
                        meta.rows
                    )));
                }
                Ok(values)
            }
        }
    }

    pub fn open(&self, column: &str) -> Result<Box<dyn ValueSource>> {
        match &self.kind {
            PartKind::Raw { dir, commit } => match commit.size_of(column) {
                None => Ok(Box::new(NullValues)),
                Some(bytes) => Ok(Box::new(ValueReader::open(
                    &column_path(dir, column),
                    Some(bytes),
                )?)),
            },
            PartKind::Sealed { dir, meta } => {
                if meta.summary_only() {
                    return Err(Error::new(SUMMARY_ONLY_PROBLEM));
                }
                if !meta.columns.iter().any(|name| name == column) {
                    return Ok(Box::new(NullValues));
                }
                if meta.plain.iter().any(|name| name == column) {
                    return Ok(Box::new(ValueReader::open(
                        &column_path(dir, column),
                        None,
                    )?));
                }
                Ok(Box::new(RunReader::open(&join(&[
                    dir,
                    &format!("{column}.rle"),
                ]))?))
            }
        }
    }
}

fn read_raw_part(dir: &str) -> Result<Part> {
    let commit = read_commit(dir)?;
    Ok(Part {
        rows: commit.rows,
        wal: commit.wal,
        columns: commit
            .columns
            .iter()
            .map(|(name, _)| name.clone())
            .collect(),
        kind: PartKind::Raw {
            dir: dir.to_string(),
            commit,
        },
    })
}

fn read_sealed_part(dir: &str) -> Result<Part> {
    let meta = read_sealed_meta(dir)?;
    Ok(Part {
        rows: meta.rows,
        wal: meta.wal,
        columns: meta.columns.clone(),
        kind: PartKind::Sealed {
            dir: dir.to_string(),
            meta,
        },
    })
}

pub fn read_day_parts(path: &str, generations: &Generations) -> Result<Vec<Part>> {
    let mut parts = Vec::new();
    if generations.sealed > 0 {
        parts.push(read_sealed_part(&join(&[
            path,
            &format!("sealed-{}", generations.sealed),
        ]))?);
    }
    for generation in &generations.raws {
        parts.push(read_raw_part(&join(&[path, &format!("raw-{generation}")]))?);
    }
    Ok(parts)
}

pub fn read_column(parts: &[Part], column: &str) -> Result<Vec<Cell>> {
    let mut values = Vec::new();
    for part in parts {
        values.extend(part.read(column)?);
    }
    Ok(values)
}

fn same_generations(a: &Generations, b: &Generations) -> bool {
    a.sealed == b.sealed && a.raws == b.raws
}

fn changed_during_read(error: &Error, path: &str, before: &Generations) -> Result<bool> {
    Ok(error.not_found && !same_generations(before, &read_generations(path)?))
}

fn pause(attempt: u32) {
    std::thread::sleep(std::time::Duration::from_millis(50 * u64::from(attempt)));
}

pub struct DayColumns {
    pub rows: u64,
    pub columns: Vec<(String, Vec<Cell>)>,
}

impl DayColumns {
    pub fn column(&self, name: &str) -> &[Cell] {
        self.columns
            .iter()
            .find(|(column, _)| column == name)
            .map_or(&[], |(_, values)| values.as_slice())
    }
}

pub fn read_day(path: &str, columns: &[String]) -> Result<DayColumns> {
    let mut attempt = 1;
    loop {
        let before = read_generations(path)?;
        let read = (|| -> Result<DayColumns> {
            let parts = read_day_parts(path, &before)?;
            let rows = parts.iter().map(|part| part.rows).sum();
            let mut values = Vec::new();
            for column in columns {
                values.push((column.clone(), read_column(&parts, column)?));
            }
            Ok(DayColumns {
                rows,
                columns: values,
            })
        })();
        match read {
            Ok(day) => {
                if same_generations(&before, &read_generations(path)?) {
                    return Ok(day);
                }
            }
            Err(error) => {
                if !changed_during_read(&error, path, &before)? {
                    return Err(error);
                }
            }
        }
        if attempt == READ_ATTEMPTS {
            return Err(Error::new(format!("{path} changed during each read")));
        }
        pause(attempt);
        attempt += 1;
    }
}

#[derive(Clone, Debug)]
pub struct DaySummary {
    pub rows: u64,
    pub wal: u64,
    pub days: Option<Value>,
    pub counts: String,
    pub tuples: Option<String>,
    pub visits: Option<String>,
}

pub fn read_day_summary(
    path: &str,
    with_visits: bool,
    accept: &dyn Fn(&SealedMeta) -> Result<bool>,
) -> Result<Option<DaySummary>> {
    let mut attempt = 1;
    loop {
        let before = read_generations(path)?;
        if before.sealed == 0 || !before.raws.is_empty() {
            return Ok(None);
        }
        let read = (|| -> Result<Option<DaySummary>> {
            let dir = join(&[path, &format!("sealed-{}", before.sealed)]);
            let meta = read_sealed_meta(&dir)?;
            if !meta.summary() || !accept(&meta)? {
                return Ok(None);
            }
            let file = |kind: &str| read_string(&join(&[&dir, summary_file(kind)]));
            Ok(Some(DaySummary {
                rows: meta.rows,
                wal: meta.wal,
                days: meta.days().cloned(),
                counts: file("counts")?,
                tuples: if with_visits {
                    Some(file("tuples")?)
                } else {
                    None
                },
                visits: if with_visits {
                    Some(file("visits")?)
                } else {
                    None
                },
            }))
        })();
        match read {
            Ok(None) => return Ok(None),
            Ok(Some(summary)) => {
                if same_generations(&before, &read_generations(path)?) {
                    return Ok(Some(summary));
                }
            }
            Err(error) => {
                if !changed_during_read(&error, path, &before)? {
                    return Err(error);
                }
            }
        }
        if attempt == READ_ATTEMPTS {
            return Err(Error::new(format!("{path} changed during each read")));
        }
        pause(attempt);
        attempt += 1;
    }
}

pub fn accept_all(_: &SealedMeta) -> Result<bool> {
    Ok(true)
}

pub fn is_summary_only_day(path: &str) -> Result<bool> {
    let generations = read_generations(path)?;
    if generations.sealed == 0 || !generations.raws.is_empty() {
        return Ok(false);
    }
    Ok(
        read_sealed_meta(&join(&[path, &format!("sealed-{}", generations.sealed)]))
            .map(|meta| meta.summary_only())
            .unwrap_or(false),
    )
}

pub struct SummaryFiles {
    pub counts: String,
    pub tuples: String,
    pub visits: String,
}

fn write_summary_folder(
    path: &str,
    generation: u64,
    rows: u64,
    wal: u64,
    files: &SummaryFiles,
    days: Option<Value>,
) -> Result<()> {
    let temporary = join(&[path, &format!("sealed-{generation}.tmp")]);
    remove_if_exists(&temporary)?;
    fs::create_dir(&temporary).map_err(|error| Error::io(&error, &temporary))?;
    for (kind, text) in [
        ("counts", &files.counts),
        ("tuples", &files.tuples),
        ("visits", &files.visits),
    ] {
        write_synced_lines(&join(&[&temporary, summary_file(kind)]), [text.as_str()])?;
    }
    let mut meta = Object::new()
        .with("rows", rows)
        .with("wal", wal)
        .with("columns", Value::Array(Vec::new()))
        .with("plain", Value::Array(Vec::new()))
        .with("summary", true)
        .with("summaryOnly", true);
    if let Some(days) = days {
        meta.insert("days", days);
    }
    write_file_atomic(
        &join(&[&temporary, SEALED_META_FILE]),
        format!("{}\n", pretty(&meta.into())).as_bytes(),
    )?;
    sync_directory(&temporary)?;
    rename(&temporary, &join(&[path, &format!("sealed-{generation}")]))?;
    sync_directory(path)
}

pub fn write_summary_day(path: &str, rows: u64, files: &SummaryFiles) -> Result<()> {
    create_dir_all(path)?;
    tidy_day(path)?;
    let generations = read_generations(path)?;
    if generations.sealed > 0 || !generations.raws.is_empty() {
        return Err(Error::new(format!("{path} already holds data")));
    }
    write_summary_folder(path, 1, rows, 0, files, None)
}

pub fn write_summary_period(
    path: &str,
    rows: u64,
    days: Value,
    files: &SummaryFiles,
) -> Result<()> {
    create_dir_all(path)?;
    tidy_day(path)?;
    let generations = read_generations(path)?;
    let generation = generations
        .raws
        .iter()
        .copied()
        .chain([generations.sealed])
        .max()
        .unwrap_or(0)
        + 1;
    write_summary_folder(path, generation, rows, 0, files, Some(days))?;
    tidy_day(path)
}

pub fn keep_only_summary(path: &str) -> Result<bool> {
    tidy_day(path)?;
    let generations = read_generations(path)?;
    if generations.sealed == 0 {
        return Ok(false);
    }
    let dir = join(&[path, &format!("sealed-{}", generations.sealed)]);
    let meta = read_sealed_meta(&dir)?;
    if meta.summary_only() || !meta.summary() {
        return Ok(false);
    }
    let file = |kind: &str| read_string(&join(&[&dir, summary_file(kind)]));
    let files = SummaryFiles {
        counts: file("counts")?,
        tuples: file("tuples")?,
        visits: file("visits")?,
    };
    let generation = generations
        .raws
        .iter()
        .copied()
        .chain([generations.sealed])
        .max()
        .unwrap_or(0)
        + 1;
    write_summary_folder(path, generation, meta.rows, meta.wal, &files, None)?;
    tidy_day(path)?;
    Ok(true)
}

pub fn tidy_day(path: &str) -> Result<()> {
    let generations = read_generations(path)?;
    for name in &generations.temporary {
        remove_if_exists(&join(&[path, name]))?;
    }
    for generation in &generations.stale_sealed {
        remove_if_exists(&join(&[path, &format!("sealed-{generation}")]))?;
    }
    for generation in &generations.stale_raws {
        remove_if_exists(&join(&[path, &format!("raw-{generation}")]))?;
    }
    Ok(())
}

pub fn seal_day(path: &str) -> Result<bool> {
    seal_day_in_chunks(path, SEAL_CHUNK_ROWS)
}

pub fn seal_day_in_chunks(path: &str, chunk_rows: usize) -> Result<bool> {
    tidy_day(path)?;
    let generations = read_generations(path)?;
    let parts = read_day_parts(path, &generations)?;
    if generations.raws.is_empty() {
        return Ok(false);
    }
    let skip = usize::from(generations.sealed > 0);
    let raw_rows: u64 = parts.iter().skip(skip).map(|part| part.rows).sum();
    let target = *generations.raws.last().unwrap_or(&0);
    if raw_rows > 0 {
        let rows: u64 = parts.iter().map(|part| part.rows).sum();
        let wal = parts.iter().map(|part| part.wal).max().unwrap_or(0);
        let columns = order_columns(
            parts
                .iter()
                .flat_map(|part| part.columns.iter().map(String::as_str)),
        );
        let row_columns = order_columns(
            columns
                .iter()
                .map(String::as_str)
                .chain(SORT_COLUMNS)
                .chain(["at"]),
        );
        let temporary = join(&[path, &format!("sealed-{target}.tmp")]);
        remove_if_exists(&temporary)?;
        fs::create_dir(&temporary).map_err(|error| Error::io(&error, &temporary))?;
        let mut summary = SummaryBuilder::new(&columns, &row_columns);
        let plain = sort_day(
            &parts,
            rows,
            &row_columns,
            &columns,
            &SORT_COLUMNS,
            "at",
            &temporary,
            chunk_rows,
            &mut |chunk, count| summary.add_rows(chunk, count),
        )?;
        let files = summary.finish();
        for kind in SUMMARY_KINDS {
            let lines = match kind {
                "counts" => &files.counts,
                "tuples" => &files.tuples,
                _ => &files.visits,
            };
            write_synced_lines(
                &join(&[&temporary, summary_file(kind)]),
                lines.iter().map(String::as_str),
            )?;
        }
        let mut sorted_by: Vec<Value> = SORT_COLUMNS.iter().map(|c| Value::from(*c)).collect();
        sorted_by.push(Value::from("at"));
        let meta = Object::new()
            .with("rows", rows)
            .with("wal", wal)
            .with("columns", columns.clone())
            .with("plain", plain)
            .with("summary", true)
            .with("sortedBy", Value::Array(sorted_by));
        write_file_atomic(
            &join(&[&temporary, SEALED_META_FILE]),
            format!("{}\n", pretty(&meta.into())).as_bytes(),
        )?;
        sync_directory(&temporary)?;
        rename(&temporary, &join(&[path, &format!("sealed-{target}")]))?;
        sync_directory(path)?;
        if generations.sealed > 0 {
            remove_if_exists(&join(&[path, &format!("sealed-{}", generations.sealed)]))?;
        }
    }
    for generation in &generations.raws {
        remove_if_exists(&join(&[path, &format!("raw-{generation}")]))?;
    }
    Ok(raw_rows > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;
    use crate::testing::TempDir;

    fn record(text: &str) -> Object {
        match parse(text).unwrap() {
            Value::Object(object) => object,
            _ => unreachable!(),
        }
    }

    fn texts(cells: &[Cell]) -> Vec<Option<String>> {
        cells
            .iter()
            .map(|cell| cell.as_deref().map(str::to_string))
            .collect()
    }

    #[test]
    fn an_append_writes_one_line_per_record_in_every_column() {
        let dir = TempDir::new();
        let raw = dir.join("raw-1");
        append_records(
            &raw,
            1,
            &[
                record(r#"{"type":"page","visit":"a","at":1,"page":"/"}"#),
                record(
                    r#"{"type":"seen","visit":"a","at":2,"page":"/","zone":"x.y","plan":"pro"}"#,
                ),
            ],
            0,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(column_path(&raw, "zone")).unwrap(),
            "\nx.y\n"
        );
        assert_eq!(
            fs::read_to_string(column_path(&raw, "plan")).unwrap(),
            "\npro\n"
        );
        append_records(
            &raw,
            2,
            &[record(r#"{"type":"error","visit":"b","at":3,"page":"/"}"#)],
            0,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(column_path(&raw, "type")).unwrap(),
            "page\nseen\nerror\n"
        );
        assert_eq!(
            fs::read_to_string(column_path(&raw, "zone")).unwrap(),
            "\nx.y\n\n"
        );
        let commit = read_commit(&raw).unwrap();
        assert_eq!((commit.rows, commit.wal), (3, 2));
    }

    #[test]
    fn a_segment_that_is_already_applied_is_skipped() {
        let dir = TempDir::new();
        let raw = dir.join("raw-1");
        let one = [record(r#"{"type":"page","visit":"a","at":1,"page":"/"}"#)];
        assert!(append_records(&raw, 5, &one, 0).unwrap());
        assert!(!append_records(&raw, 5, &one, 0).unwrap());
        assert!(!append_records(&raw, 4, &one, 0).unwrap());
        assert!(!append_records(&dir.join("raw-2"), 3, &one, 3).unwrap());
    }

    #[test]
    fn a_torn_tail_after_a_crash_is_ignored_by_readers_and_cut_by_the_next_append() {
        let dir = TempDir::new();
        let day = dir.path.clone();
        let raw = dir.join("raw-1");
        let one = [record(r#"{"type":"page","visit":"a","at":1,"page":"/"}"#)];
        append_records(&raw, 1, &one, 0).unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(column_path(&raw, "type"))
            .unwrap();
        file.write_all(b"torn").unwrap();
        let read = read_day(&day, &["type".to_string()]).unwrap();
        assert_eq!(texts(read.column("type")), [Some("page".to_string())]);
        append_records(&raw, 2, &one, 0).unwrap();
        assert_eq!(
            fs::read_to_string(column_path(&raw, "type")).unwrap(),
            "page\npage\n"
        );
    }

    #[test]
    fn sealing_sorts_the_rows_keeps_them_aligned_and_runs_the_values() {
        let dir = TempDir::new();
        let day = dir.path.clone();
        let records: Vec<Object> = (0..20)
            .map(|at| {
                record(&format!(
                    r#"{{"type":"{}","visit":"v{}","at":{},"page":"/{}"}}"#,
                    if at % 2 == 0 { "page" } else { "error" },
                    at % 3,
                    100 - at,
                    at % 2
                ))
            })
            .collect();
        append_records(&join(&[&day, "raw-1"]), 1, &records, 0).unwrap();
        let columns: Vec<String> = ["type", "visit", "at", "page"]
            .iter()
            .map(|c| c.to_string())
            .collect();
        let before = read_day(&day, &columns).unwrap();
        assert!(seal_day(&day).unwrap());
        let after = read_day(&day, &columns).unwrap();
        let rows = |data: &DayColumns| {
            let mut out: Vec<Vec<Option<String>>> = (0..data.rows as usize)
                .map(|row| {
                    columns
                        .iter()
                        .map(|c| data.column(c)[row].as_deref().map(str::to_string))
                        .collect()
                })
                .collect();
            out.sort();
            out
        };
        assert_eq!(rows(&before), rows(&after));
        let pages = texts(after.column("page"));
        let mut sorted = pages.clone();
        sorted.sort();
        assert_eq!(pages, sorted);
        let meta = read_sealed_meta(&join(&[&day, "sealed-1"])).unwrap();
        assert!(meta.plain.contains(&"at".to_string()));
        assert!(!meta.plain.contains(&"page".to_string()));
        assert_eq!(
            fs::read_to_string(join(&[&day, "sealed-1", "page.rle"])).unwrap(),
            "10\t/0\n10\t/1\n"
        );
    }

    #[test]
    fn sealing_in_small_chunks_writes_the_same_files_as_one_chunk() {
        let make = || {
            let dir = TempDir::new();
            let records: Vec<Object> = (0..500)
                .map(|at| {
                    record(&format!(
                        r#"{{"type":"page","visit":"v{}","at":{},"page":"/{}","plan":"p{}"}}"#,
                        at % 17,
                        1000 + (at * 7919) % 500,
                        at % 5,
                        at % 3
                    ))
                })
                .collect();
            append_records(&dir.join("raw-1"), 1, &records, 0).unwrap();
            dir
        };
        let one = make();
        let many = make();
        seal_day_in_chunks(&one.path, 100_000).unwrap();
        seal_day_in_chunks(&many.path, 7).unwrap();
        for name in [
            "type.rle",
            "visit.rle",
            "at.txt",
            "page.rle",
            "plan.rle",
            "summary-counts.tsv",
            "summary-tuples.tsv",
            "summary-visits.tsv",
        ] {
            let read = |dir: &TempDir| {
                fs::read_to_string(join(&[&dir.path, "sealed-1", name])).unwrap_or_default()
            };
            assert_eq!(read(&one), read(&many), "{name}");
        }
    }

    #[test]
    fn records_that_arrive_after_sealing_are_read_and_sealed_again() {
        let dir = TempDir::new();
        let day = dir.path.clone();
        let one = [record(r#"{"type":"page","visit":"a","at":1,"page":"/"}"#)];
        append_records(&join(&[&day, "raw-1"]), 1, &one, 0).unwrap();
        seal_day(&day).unwrap();
        let target = append_target(&day).unwrap().unwrap();
        assert_eq!(target.dir, join(&[&day, "raw-2"]));
        assert_eq!(target.applied_wal, 1);
        append_records(&target.dir, 2, &one, target.applied_wal).unwrap();
        assert_eq!(read_day(&day, &["type".to_string()]).unwrap().rows, 2);
        seal_day(&day).unwrap();
        let generations = read_generations(&day).unwrap();
        assert_eq!((generations.sealed, generations.raws.len()), (2, 0));
        assert_eq!(read_day(&day, &["type".to_string()]).unwrap().rows, 2);
    }

    #[test]
    fn leftovers_of_an_interrupted_seal_are_tidied() {
        let dir = TempDir::new();
        let day = dir.path.clone();
        let one = [record(r#"{"type":"page","visit":"a","at":1,"page":"/"}"#)];
        append_records(&join(&[&day, "raw-1"]), 1, &one, 0).unwrap();
        fs::create_dir_all(join(&[&day, "sealed-1.tmp"])).unwrap();
        seal_day(&day).unwrap();
        fs::create_dir_all(join(&[&day, "raw-1"])).unwrap();
        tidy_day(&day).unwrap();
        let names: Vec<String> = list_directory(&day)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["sealed-1"]);
    }

    #[test]
    fn a_raw_folder_before_its_first_commit_reads_as_empty() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.join("raw-1")).unwrap();
        assert_eq!(read_day(&dir.path, &["type".to_string()]).unwrap().rows, 0);
        assert!(!seal_day(&dir.path).unwrap());
    }
}
