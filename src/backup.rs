use crate::column_store::{
    DaySummary, SummaryFiles, accept_all, list_apps, list_days, list_sources, read_day_summary,
    read_generations, source_dir, write_summary_day, write_summary_period,
};
use crate::days::{
    DAY_MS, PeriodKind, add_days, add_months, day_end_ms, day_of, is_day, is_period_id, period_days,
};
use crate::error::{Error, Result};
use crate::json::{Object, Value};
use crate::logger;
use crate::names::{is_app_name, is_source};
use crate::periods::{
    DayState, DayStates, days_value, list_period_sources, list_periods, period_end_ms,
    period_source_dir, read_period_summary,
};
use crate::records::DEFAULT_SEAL_DELAY_MS;
use crate::summary::{
    PERIOD_DAYS_FILE, check_summary, format_period_days, parse_period_days, summary_file,
};
use crate::tar::{TarReader, write_end, write_entry};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufReader, Read, Write};

pub const MAX_SUMMARY_FILE_BYTES: u64 = 268_435_456;

pub const BACKUP_PERIODS: [&str; 7] = ["1d", "7d", "30d", "3m", "6m", "1y", "all"];

pub const BACKUP_KINDS: [&str; 3] = ["day", "week", "month"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Days,
    Weeks,
    Months,
}

impl Kind {
    pub fn of_granularity(by: &str) -> Option<Kind> {
        match by {
            "day" => Some(Kind::Days),
            "week" => Some(Kind::Weeks),
            "month" => Some(Kind::Months),
            _ => None,
        }
    }

    pub fn dir(self) -> &'static str {
        match self {
            Kind::Days => "days",
            Kind::Weeks => "weeks",
            Kind::Months => "months",
        }
    }

    fn from_dir(text: &str) -> Option<Kind> {
        match text {
            "days" => Some(Kind::Days),
            "weeks" => Some(Kind::Weeks),
            "months" => Some(Kind::Months),
            _ => None,
        }
    }

    pub fn id_name(self) -> &'static str {
        match self {
            Kind::Days => "day",
            Kind::Weeks => "week",
            Kind::Months => "month",
        }
    }

    fn period(self) -> Option<PeriodKind> {
        match self {
            Kind::Days => None,
            Kind::Weeks => Some(PeriodKind::Weeks),
            Kind::Months => Some(PeriodKind::Months),
        }
    }

    fn files(self) -> &'static [&'static str] {
        match self {
            Kind::Days => &["counts", "tuples", "visits"],
            _ => &["counts", "tuples", "visits", "days"],
        }
    }
}

fn backup_error(message: impl Into<String>) -> Error {
    Error::status(400, message)
}

pub struct BackupOptions {
    pub last: String,
    pub by: String,
}

pub fn parse_backup_options(params: &[(String, String)]) -> Result<BackupOptions> {
    let unknown: Vec<&str> = params
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| *key != "last" && *key != "by")
        .collect();
    if !unknown.is_empty() {
        return Err(backup_error(format!(
            "unknown backup options: {} - use last and by",
            unknown.join(", ")
        )));
    }
    let get = |name: &str, default: &str| {
        params
            .iter()
            .find(|(key, _)| key == name)
            .map_or(default.to_string(), |(_, value)| value.clone())
    };
    let last = get("last", "all");
    let by = get("by", "day");
    if !BACKUP_PERIODS.contains(&last.as_str()) {
        return Err(backup_error(format!(
            "last is one of {}",
            BACKUP_PERIODS.join(", ")
        )));
    }
    if !BACKUP_KINDS.contains(&by.as_str()) {
        return Err(backup_error(format!(
            "by is one of {}",
            BACKUP_KINDS.join(", ")
        )));
    }
    Ok(BackupOptions { last, by })
}

pub struct Range {
    pub from: Option<String>,
    pub to: String,
}

pub fn backup_range(last: &str, now: i64, seal_delay_ms: i64) -> Range {
    let to = day_of(now - seal_delay_ms - DAY_MS);
    let from = match last {
        "1d" => Some(add_days(&to, 0)),
        "7d" => Some(add_days(&to, -6)),
        "30d" => Some(add_days(&to, -29)),
        "3m" => Some(add_days(&add_months(&to, -3), 1)),
        "6m" => Some(add_days(&add_months(&to, -6), 1)),
        "1y" => Some(add_days(&add_months(&to, -12), 1)),
        _ => None,
    };
    Range { from, to }
}

fn in_range(day: &str, range: &Range) -> bool {
    range.from.as_deref().is_none_or(|from| day >= from) && day <= range.to.as_str()
}

fn in_period(kind: PeriodKind, id: &str, range: &Range) -> bool {
    let days = period_days(kind, id);
    let first = days.first().map_or("", String::as_str);
    let last = days.last().map_or("", String::as_str);
    range.from.as_deref().is_none_or(|from| first >= from) && last <= range.to.as_str()
}

fn write_summary(
    out: &mut impl Write,
    app: &str,
    source: &str,
    kind: Kind,
    id: &str,
    summary: &DaySummary,
    mtime_ms: i64,
) -> io::Result<()> {
    let days_text = if kind == Kind::Days {
        String::new()
    } else {
        let days: Vec<(String, u64)> = summary
            .days
            .as_ref()
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .map(|(day, state)| {
                        let rows = state
                            .get("rows")
                            .and_then(Value::as_safe_integer)
                            .unwrap_or(0);
                        (day.clone(), rows.max(0) as u64)
                    })
                    .collect()
            })
            .unwrap_or_default();
        format_period_days(&days)
    };
    for part in kind.files() {
        let text = match *part {
            "counts" => summary.counts.as_str(),
            "tuples" => summary.tuples.as_deref().unwrap_or(""),
            "visits" => summary.visits.as_deref().unwrap_or(""),
            _ => days_text.as_str(),
        };
        let name = format!("{app}/{source}/{}/{id}/{}", kind.dir(), summary_file(part));
        write_entry(out, &name, text.as_bytes(), mtime_ms)?;
    }
    Ok(())
}

pub fn write_backup(
    data_dir: &str,
    last: &str,
    by: &str,
    now: i64,
    seal_delay_ms: i64,
    output: impl Write,
) -> io::Result<()> {
    let kind = Kind::of_granularity(by).unwrap_or(Kind::Days);
    let range = backup_range(last, now, seal_delay_ms);
    let mut out = GzEncoder::new(output, Compression::default());
    let io_error = |error: Error| io::Error::other(error.message);
    for app in list_apps(data_dir).map_err(io_error)? {
        match kind.period() {
            None => {
                for day in list_days(data_dir, &app).map_err(io_error)? {
                    if !in_range(&day, &range) {
                        continue;
                    }
                    for source in list_sources(data_dir, &app, &day).map_err(io_error)? {
                        match read_day_summary(
                            &source_dir(data_dir, &app, &day, &source),
                            true,
                            &accept_all,
                        ) {
                            Ok(Some(summary)) => {
                                write_summary(&mut out, &app, &source, kind, &day, &summary, now)?;
                            }
                            Ok(None) => {}
                            Err(error) => logger::warn(format!(
                                "The backup skipped {app}/{day}/{source}: {error}"
                            )),
                        }
                    }
                }
            }
            Some(period) => {
                for id in list_periods(data_dir, &app, period).map_err(io_error)? {
                    if !in_period(period, &id, &range) {
                        continue;
                    }
                    for source in
                        list_period_sources(data_dir, &app, period, &id).map_err(io_error)?
                    {
                        match read_period_summary(data_dir, &app, period, &id, &source, true) {
                            Ok(Some(summary)) => {
                                write_summary(&mut out, &app, &source, kind, &id, &summary, now)?;
                            }
                            Ok(None) => {}
                            Err(error) => logger::warn(format!(
                                "The backup skipped {app}/{}/{id}/{source}: {error}",
                                period.dir()
                            )),
                        }
                    }
                }
            }
        }
    }
    write_end(&mut out)?;
    out.finish()?.flush()
}

pub fn write_backup_default(data_dir: &str, output: impl Write) -> io::Result<()> {
    write_backup(
        data_dir,
        "all",
        "day",
        crate::days::now_ms(),
        DEFAULT_SEAL_DELAY_MS,
        output,
    )
}

pub struct Entry {
    pub app: String,
    pub source: String,
    pub kind: Kind,
    pub id: String,
    pub rows: u64,
    pub files: SummaryFiles,
    pub days: Vec<(String, u64)>,
}

struct Pending {
    key: String,
    app: String,
    source: String,
    kind: Kind,
    id: String,
    files: Vec<(String, String)>,
}

fn is_entry_id(kind: Kind, id: &str) -> bool {
    match kind.period() {
        None => is_day(id),
        Some(period) => is_period_id(period, id),
    }
}

fn part_of_file(file: &str) -> Option<&'static str> {
    ["counts", "tuples", "visits", "days"]
        .into_iter()
        .find(|part| summary_file(part) == file)
}

fn finish_entry(pending: Pending) -> std::result::Result<Entry, String> {
    let get = |part: &str| {
        pending
            .files
            .iter()
            .find(|(name, _)| name == part)
            .map(|(_, text)| text.clone())
    };
    let missing: Vec<&str> = pending
        .kind
        .files()
        .iter()
        .filter(|part| get(part).is_none())
        .map(|part| summary_file(part))
        .collect();
    if !missing.is_empty() {
        return Err(format!("{} has no {}", pending.key, missing.join(", ")));
    }
    let files = SummaryFiles {
        counts: get("counts").unwrap_or_default(),
        tuples: get("tuples").unwrap_or_default(),
        visits: get("visits").unwrap_or_default(),
    };
    let rows = check_summary(&files.counts, &files.tuples, &files.visits)
        .map_err(|error| format!("{}: {error}", pending.key))?;
    let days = match pending.kind.period() {
        None => Vec::new(),
        Some(period) => {
            let (days, day_rows) = parse_period_days(
                &get("days").unwrap_or_default(),
                &period_days(period, &pending.id),
            )
            .map_err(|error| format!("{}: {error}", pending.key))?;
            if day_rows != rows {
                return Err(format!(
                    "{}: {PERIOD_DAYS_FILE} does not match the counts",
                    pending.key
                ));
            }
            days
        }
    };
    Ok(Entry {
        app: pending.app,
        source: pending.source,
        kind: pending.kind,
        id: pending.id,
        rows,
        files,
        days,
    })
}

pub struct BackupReader<R: Read> {
    tar: TarReader<GzDecoder<R>>,
    seen: HashSet<String>,
    current: Option<Pending>,
    done: bool,
}

impl<R: Read> BackupReader<R> {
    pub fn new(input: R) -> Self {
        BackupReader {
            tar: TarReader::new(GzDecoder::new(input), MAX_SUMMARY_FILE_BYTES),
            seen: HashSet::new(),
            current: None,
            done: false,
        }
    }

    fn step(&mut self) -> std::result::Result<Option<Entry>, String> {
        loop {
            if self.done {
                return Ok(None);
            }
            let Some((name, data)) = self.tar.next_entry()? else {
                self.done = true;
                return match self.current.take() {
                    Some(pending) => finish_entry(pending).map(Some),
                    None => Ok(None),
                };
            };
            let parts: Vec<&str> = name.split('/').collect();
            let valid = parts.len() == 5
                && is_app_name(parts[0])
                && is_source(parts[1])
                && Kind::from_dir(parts[2]).is_some_and(|kind| {
                    is_entry_id(kind, parts[3])
                        && part_of_file(parts[4]).is_some_and(|part| kind.files().contains(&part))
                });
            if !valid {
                return Err(format!(
                    "{name} is not a summary file of an app and a source"
                ));
            }
            let kind = Kind::from_dir(parts[2]).unwrap_or(Kind::Days);
            let key = format!("{}/{}/{}/{}", parts[0], parts[1], parts[2], parts[3]);
            let mut finished = None;
            if self.current.as_ref().map(|pending| &pending.key) != Some(&key) {
                if let Some(pending) = self.current.take() {
                    finished = Some(finish_entry(pending)?);
                }
                if !self.seen.insert(key.clone()) {
                    return Err(format!("the files of {key} are not next to each other"));
                }
                self.current = Some(Pending {
                    key: key.clone(),
                    app: parts[0].to_string(),
                    source: parts[1].to_string(),
                    kind,
                    id: parts[3].to_string(),
                    files: Vec::new(),
                });
            }
            let part = part_of_file(parts[4]).unwrap_or("counts");
            let current = self
                .current
                .as_mut()
                .ok_or("the backup reader lost its entry")?;
            if current.files.iter().any(|(name, _)| name == part) {
                return Err(format!("{name} is in the backup twice"));
            }
            let text = String::from_utf8(data).map_err(|_| format!("{name} is not UTF-8 text"))?;
            current.files.push((part.to_string(), text));
            if let Some(entry) = finished {
                return Ok(Some(entry));
            }
        }
    }

    pub fn next_entry(&mut self) -> Result<Option<Entry>> {
        self.step()
            .map_err(|error| backup_error(format!("the backup is not valid: {error}")))
    }
}

pub struct BackupCount {
    pub apps: usize,
    pub sources: usize,
    pub days: usize,
    pub weeks: usize,
    pub months: usize,
}

pub fn count_backup(input: impl Read) -> Result<BackupCount> {
    let mut reader = BackupReader::new(input);
    let mut apps = HashSet::new();
    let mut sources = HashSet::new();
    let mut count = BackupCount {
        apps: 0,
        sources: 0,
        days: 0,
        weeks: 0,
        months: 0,
    };
    while let Some(entry) = reader.next_entry()? {
        apps.insert(entry.app);
        sources.insert(entry.source);
        match entry.kind {
            Kind::Days => count.days += 1,
            Kind::Weeks => count.weeks += 1,
            Kind::Months => count.months += 1,
        }
    }
    count.apps = apps.len();
    count.sources = sources.len();
    Ok(count)
}

fn restore_day(
    data_dir: &str,
    entry: &Entry,
    now: i64,
    seal_delay_ms: i64,
) -> Result<Option<String>> {
    if now < day_end_ms(&entry.id) + seal_delay_ms {
        return Ok(Some("the day is not sealed yet".to_string()));
    }
    let path = source_dir(data_dir, &entry.app, &entry.id, &entry.source);
    let generations = read_generations(&path)?;
    if generations.sealed > 0 || !generations.raws.is_empty() {
        return Ok(Some(
            "the server already stores the day of the source".to_string(),
        ));
    }
    write_summary_day(&path, entry.rows, &entry.files)?;
    Ok(None)
}

fn restore_period(
    data_dir: &str,
    entry: &Entry,
    period: PeriodKind,
    now: i64,
    seal_delay_ms: i64,
) -> Result<Option<String>> {
    let name = period.name();
    if now < period_end_ms(period, &entry.id) + seal_delay_ms {
        return Ok(Some(format!("the {name} is not sealed yet")));
    }
    let path = period_source_dir(data_dir, &entry.app, period, &entry.id, &entry.source);
    let generations = read_generations(&path)?;
    if generations.sealed > 0 || !generations.raws.is_empty() {
        return Ok(Some(format!(
            "the server already stores the {name} of the source"
        )));
    }
    let states: DayStates = entry
        .days
        .iter()
        .map(|(day, rows)| {
            (
                day.clone(),
                DayState {
                    rows: *rows,
                    wal: 0,
                },
            )
        })
        .collect();
    write_summary_period(&path, entry.rows, days_value(&states), &entry.files)?;
    Ok(None)
}

fn open_file(path: &str) -> Result<BufReader<File>> {
    File::open(path)
        .map(BufReader::new)
        .map_err(|error| Error::io(&error, path))
}

pub fn restore_backup_file(
    data_dir: &str,
    path: &str,
    now: i64,
    seal_delay_ms: i64,
) -> Result<Value> {
    count_backup(open_file(path)?)?;
    let mut reader = BackupReader::new(open_file(path)?);
    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    while let Some(entry) = reader.next_entry()? {
        let reason = match entry.kind.period() {
            None => restore_day(data_dir, &entry, now, seal_delay_ms)?,
            Some(period) => restore_period(data_dir, &entry, period, now, seal_delay_ms)?,
        };
        let name = entry.kind.id_name();
        let mut item = Object::new()
            .with("app", entry.app.clone())
            .with("source", entry.source.clone())
            .with(name, entry.id.clone());
        match reason {
            Some(reason) => {
                item.insert("reason", reason);
                skipped.push(Value::Object(item));
            }
            None => {
                logger::info(format!(
                    "Restored the summary of the {name} {}/{} of the source {}",
                    entry.app, entry.id, entry.source
                ));
                restored.push(Value::Object(item));
            }
        }
    }
    Ok(Object::new()
        .with("restored", Value::Array(restored))
        .with("skipped", Value::Array(skipped))
        .into())
}
