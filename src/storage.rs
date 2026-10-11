use crate::backup::restore_backup_file;
use crate::column_store::{append_records, append_target, read_generations, seal_day, source_dir};
use crate::days::{PERIOD_KINDS, day_end_ms, is_day, iso, now_ms, period_of};
use crate::error::{Error, Result};
use crate::fsutil::{
    create_dir_all, list_directory, read_string, remove_if_exists, write_file_atomic,
};
use crate::json::{self, Object, Value};
use crate::logger;
use crate::names::{is_app_name, is_column_name, is_source};
use crate::paths::join;
use crate::periods::{due_periods, update_period_summary};
use crate::records::DEFAULT_SEAL_DELAY_MS;
use crate::retention::{MinFree, UsageFn, disk_usage, enforce_retention, list_stored_days};
use crate::wal::{
    Extension, list_closed_segments, read_applied_segment, segment_file_name, write_applied_segment,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::oneshot;

pub const DEFAULT_MAINTENANCE_MS: i64 = 60_000;

const RETRY_MS: u64 = 5_000;

const IDLE_MS: u64 = 1_000;

const READ_ATTEMPTS: u32 = 3;

const RESTART_MS: u64 = 5_000;

const STOP_TIMEOUT: Duration = Duration::from_secs(10);

pub const HELD_DIR: &str = "held";

pub const UNREADABLE_SUFFIX: &str = ".unreadable";

pub fn held_dir(data_dir: &str, app: &str, day: &str) -> String {
    join(&[data_dir, "wal", HELD_DIR, app, day])
}

pub struct Group {
    pub app: String,
    pub day: String,
    pub records: Vec<Object>,
}

impl Group {
    fn key(&self) -> String {
        format!("{}/{}", self.app, self.day)
    }
}

#[derive(Default)]
pub struct Counts {
    pub dropped: u64,
    pub stored: BTreeSet<String>,
}

pub fn parse_segment(text: &str, counts: &mut Counts) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut skipped = 0u64;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Array(entry)) = json::parse(line) else {
            skipped += 1;
            continue;
        };
        if entry.len() != 3 {
            skipped += 1;
            continue;
        }
        let (Some(app), Some(day)) = (entry[0].as_str(), entry[1].as_str()) else {
            skipped += 1;
            continue;
        };
        if !is_app_name(app) || !is_day(day) {
            skipped += 1;
            continue;
        }
        let mut record = Object::new();
        match &entry[2] {
            Value::Object(input) => {
                for (key, value) in input.iter() {
                    if is_column_name(key) && matches!(value, Value::String(_) | Value::Number(_)) {
                        record.insert(key.clone(), value.clone());
                    }
                }
            }
            Value::Array(_) => {}
            _ => {
                skipped += 1;
                continue;
            }
        }
        let key = format!("{app}/{day}");
        let at = *index.entry(key).or_insert_with(|| {
            groups.push(Group {
                app: app.to_string(),
                day: day.to_string(),
                records: Vec::new(),
            });
            groups.len() - 1
        });
        groups[at].records.push(record);
    }
    if skipped > 0 {
        logger::warn(format!(
            "Skipped {skipped} unreadable lines of the write-ahead log"
        ));
    }
    counts.dropped += skipped;
    groups
}

fn apply_group(
    data_dir: &str,
    source: &str,
    segment: u64,
    group: &Group,
    counts: &mut Counts,
) -> Result<u64> {
    let key = group.key();
    let Some(target) = append_target(&source_dir(data_dir, &group.app, &group.day, source))? else {
        counts.dropped += group.records.len() as u64;
        logger::error(format!(
            "Dropped {} records of {key}: only the daily summary of the day is stored",
            group.records.len()
        ));
        return Ok(0);
    };
    if append_records(&target.dir, segment, &group.records, target.applied_wal)? {
        counts.stored.insert(key);
        return Ok(group.records.len() as u64);
    }
    logger::warn(format!(
        "Log part {segment} is already stored in {key}, skipped"
    ));
    Ok(0)
}

fn hold_group(data_dir: &str, segment: u64, group: &Group) -> Result<()> {
    let dir = held_dir(data_dir, &group.app, &group.day);
    create_dir_all(&dir)?;
    let text: String = group
        .records
        .iter()
        .map(|record| format!("{}\n", json::stringify(&Value::Object(record.clone()))))
        .collect();
    write_file_atomic(
        &join(&[&dir, &segment_file_name(segment, Extension::Log, None)]),
        text.as_bytes(),
    )
}

fn check_source(source: &str) -> Result<()> {
    if !is_source(source) {
        return Err(Error::new(format!(
            "the storage needs a source id, not {source}"
        )));
    }
    Ok(())
}

pub fn apply_segment(
    data_dir: &str,
    source: &str,
    segment: u64,
    text: &str,
    held: &mut BTreeMap<String, Option<String>>,
    counts: &mut Counts,
) -> Result<u64> {
    check_source(source)?;
    let mut rows = 0;
    for group in parse_segment(text, counts) {
        let key = group.key();
        if let std::collections::btree_map::Entry::Vacant(entry) = held.entry(key.clone()) {
            match apply_group(data_dir, source, segment, &group, counts) {
                Ok(count) => {
                    rows += count;
                    continue;
                }
                Err(error) => {
                    logger::error(format!(
                        "Cannot store {key}, kept its records aside to try again later: {error}"
                    ));
                    entry.insert(Some(error.message));
                }
            }
        }
        hold_group(data_dir, segment, &group)?;
    }
    Ok(rows)
}

pub fn apply_segment_text(data_dir: &str, source: &str, segment: u64, text: &str) -> Result<u64> {
    apply_segment(
        data_dir,
        source,
        segment,
        text,
        &mut BTreeMap::new(),
        &mut Counts::default(),
    )
}

pub fn list_held_days(data_dir: &str) -> Result<Vec<String>> {
    let base = join(&[data_dir, "wal", HELD_DIR]);
    let mut held = Vec::new();
    for app in list_directory(&base)? {
        if !app.is_dir || !is_app_name(&app.name) {
            continue;
        }
        for day in list_directory(&join(&[&base, &app.name]))? {
            if day.is_dir && is_day(&day.name) {
                held.push(format!("{}/{}", app.name, day.name));
            }
        }
    }
    Ok(held)
}

pub fn retry_held_day(data_dir: &str, source: &str, key: &str, counts: &mut Counts) -> Result<u64> {
    let (app, day) = key.split_once('/').unwrap_or((key, ""));
    let dir = held_dir(data_dir, app, day);
    let mut rows = 0;
    for segment in list_closed_segments(&dir)? {
        let text = read_string(&segment.path)?;
        let mut records = Vec::new();
        for line in text.split('\n').filter(|line| !line.is_empty()) {
            match json::parse(line) {
                Ok(Value::Object(record)) => records.push(record),
                _ => {
                    return Err(Error::new(format!(
                        "{} holds a line that is not a record",
                        segment.path
                    )));
                }
            }
        }
        let group = Group {
            app: app.to_string(),
            day: day.to_string(),
            records,
        };
        rows += apply_group(data_dir, source, segment.id, &group, counts)?;
        remove_if_exists(&segment.path)?;
    }
    remove_if_exists(&dir)?;
    Ok(rows)
}

pub fn list_unsealed_days(data_dir: &str, source: &str) -> Result<BTreeSet<String>> {
    let mut unsealed = BTreeSet::new();
    for (app, day) in list_stored_days(data_dir)? {
        if !read_generations(&source_dir(data_dir, &app, &day, source))?
            .raws
            .is_empty()
        {
            unsealed.insert(format!("{app}/{day}"));
        }
    }
    Ok(unsealed)
}

pub fn seal_due_days(
    data_dir: &str,
    source: &str,
    now: i64,
    seal_delay_ms: i64,
    unsealed: &mut BTreeSet<String>,
) -> Vec<String> {
    let mut sealed = Vec::new();
    for key in unsealed.clone() {
        let (app, day) = key.split_once('/').unwrap_or((&key, ""));
        if now < day_end_ms(day) + seal_delay_ms {
            continue;
        }
        match seal_day(&source_dir(data_dir, app, day, source)) {
            Ok(done) => {
                if done {
                    sealed.push(key.clone());
                    logger::info(format!("Sealed {key}"));
                }
                unsealed.remove(&key);
            }
            Err(error) => logger::error(format!("Cannot seal {key}: {error}")),
        }
    }
    sealed
}

pub fn seal_all_due_days(
    data_dir: &str,
    source: &str,
    now: i64,
    seal_delay_ms: i64,
) -> Vec<String> {
    match list_unsealed_days(data_dir, source) {
        Ok(mut unsealed) => seal_due_days(data_dir, source, now, seal_delay_ms, &mut unsealed),
        Err(error) => {
            logger::error(format!("Cannot list the stored days: {error}"));
            Vec::new()
        }
    }
}

pub fn seal_due_periods(
    data_dir: &str,
    source: &str,
    now: i64,
    seal_delay_ms: i64,
    checked: &mut HashSet<String>,
) -> Vec<String> {
    let mut built = Vec::new();
    let days = list_stored_days(data_dir).unwrap_or_else(|error| {
        logger::error(format!("Cannot list the stored days: {error}"));
        Vec::new()
    });
    for period in due_periods(&days, now, seal_delay_ms, checked) {
        match update_period_summary(data_dir, &period.app, period.kind, &period.id, source) {
            Ok(done) => {
                if done {
                    built.push(period.key.clone());
                    logger::info(format!("Made the summary of {}", period.key));
                }
                checked.insert(period.key);
            }
            Err(error) => logger::error(format!(
                "Cannot make the summary of {}: {error}",
                period.key
            )),
        }
    }
    built
}

fn period_keys_of(sealed: &[String]) -> Vec<String> {
    let mut keys = Vec::new();
    for key in sealed {
        let (app, day) = key.split_once('/').unwrap_or((key, ""));
        for kind in PERIOD_KINDS {
            keys.push(format!("{app}/{}/{}", kind.dir(), period_of(kind, day)));
        }
    }
    keys
}

pub type RestoreReply = oneshot::Sender<std::result::Result<Value, Error>>;

pub enum Message {
    Wake,
    Restore(String, RestoreReply),
    Stop,
}

#[derive(Clone)]
pub struct StorageOptions {
    pub data_dir: String,
    pub source: String,
    pub min_free: Option<MinFree>,
    pub seal_delay_ms: i64,
    pub maintenance_ms: i64,
    pub retry_ms: u64,
    pub usage: Arc<UsageFn>,
}

impl StorageOptions {
    pub fn new(data_dir: &str, source: &str) -> Self {
        StorageOptions {
            data_dir: data_dir.to_string(),
            source: source.to_string(),
            min_free: None,
            seal_delay_ms: DEFAULT_SEAL_DELAY_MS,
            maintenance_ms: DEFAULT_MAINTENANCE_MS,
            retry_ms: RETRY_MS,
            usage: Arc::new(disk_usage),
        }
    }
}

#[derive(Default)]
struct Status {
    pending_segments: u64,
    processed_rows: u64,
    last_processed_at: Option<String>,
    last_error: Option<String>,
    unreadable_segments: u64,
    disk: Option<Value>,
    retention_error: Option<String>,
}

pub struct Storage {
    options: StorageOptions,
    wal_dir: String,
    receiver: mpsc::Receiver<Message>,
    stopping: bool,
    woken: bool,
    last_maintenance: Option<i64>,
    last_seal: Option<i64>,
    last_held_retry: Option<i64>,
    held_loaded: bool,
    unsealed: Option<BTreeSet<String>>,
    counts: Counts,
    held: BTreeMap<String, Option<String>>,
    read_failures: HashMap<u64, u32>,
    restores: Vec<(String, RestoreReply)>,
    checked_periods: HashSet<String>,
    status: Status,
    published: Arc<Mutex<Option<Value>>>,
}

impl Storage {
    fn snapshot(&self) -> Value {
        let held: Vec<Value> = self
            .held
            .iter()
            .map(|(day, error)| {
                Object::new()
                    .with("day", day.clone())
                    .with("error", error.clone())
                    .into()
            })
            .collect();
        Object::new()
            .with("pendingSegments", self.status.pending_segments)
            .with("processedRows", self.status.processed_rows)
            .with("lastProcessedAt", self.status.last_processed_at.clone())
            .with("lastError", self.status.last_error.clone())
            .with("unreadableSegments", self.status.unreadable_segments)
            .with("disk", self.status.disk.clone().unwrap_or(Value::Null))
            .with("retentionError", self.status.retention_error.clone())
            .with("droppedRecords", self.counts.dropped)
            .with("heldDays", Value::Array(held))
            .into()
    }

    fn take_message(&mut self, message: Message) {
        match message {
            Message::Wake => self.woken = true,
            Message::Restore(path, reply) => {
                self.restores.push((path, reply));
                self.woken = true;
            }
            Message::Stop => {
                self.stopping = true;
                self.woken = true;
            }
        }
    }

    fn drain(&mut self) {
        while let Ok(message) = self.receiver.try_recv() {
            self.take_message(message);
        }
    }

    fn sleep(&mut self, ms: u64) {
        self.drain();
        if self.woken {
            self.woken = false;
            return;
        }
        match self.receiver.recv_timeout(Duration::from_millis(ms)) {
            Ok(message) => self.take_message(message),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => self.stopping = true,
        }
        self.drain();
        self.woken = false;
    }

    fn read_segment(
        &mut self,
        id: u64,
        path: &str,
        valid_bytes: Option<u64>,
    ) -> Result<Option<String>> {
        match std::fs::read(path) {
            Ok(bytes) => {
                self.read_failures.remove(&id);
                let end =
                    valid_bytes.map_or(bytes.len(), |valid| (valid as usize).min(bytes.len()));
                Ok(Some(String::from_utf8_lossy(&bytes[..end]).into_owned()))
            }
            Err(error) => {
                let failures = self.read_failures.get(&id).copied().unwrap_or(0) + 1;
                self.read_failures.insert(id, failures);
                if failures < READ_ATTEMPTS {
                    return Err(Error::io(&error, path));
                }
                self.read_failures.remove(&id);
                let target = format!("{path}{UNREADABLE_SUFFIX}");
                std::fs::rename(path, &target).map_err(|error| Error::io(&error, path))?;
                logger::error(format!(
                    "Cannot read log part {id} {READ_ATTEMPTS} times, renamed it to {target}: {error}"
                ));
                Ok(None)
            }
        }
    }

    fn process_pending(&mut self) -> Result<()> {
        let data_dir = self.options.data_dir.clone();
        if !self.held_loaded {
            for key in list_held_days(&data_dir)? {
                self.held.insert(key, None);
            }
            self.held_loaded = true;
        }
        let applied = read_applied_segment(&self.wal_dir)?;
        self.status.unreadable_segments = list_directory(&self.wal_dir)?
            .iter()
            .filter(|entry| entry.name.ends_with(UNREADABLE_SUFFIX))
            .count() as u64;
        let segments = list_closed_segments(&self.wal_dir)?;
        self.status.pending_segments = segments.len() as u64;
        for segment in segments {
            self.drain();
            if self.stopping {
                return Ok(());
            }
            let text = if segment.id > applied {
                self.read_segment(segment.id, &segment.path, segment.valid_bytes)?
            } else {
                Some(String::new())
            };
            if text.is_none() {
                self.status.unreadable_segments += 1;
            }
            if segment.id > applied {
                if let Some(text) = text.as_deref().filter(|text| !text.is_empty()) {
                    let source = self.options.source.clone();
                    self.status.processed_rows += apply_segment(
                        &data_dir,
                        &source,
                        segment.id,
                        text,
                        &mut self.held,
                        &mut self.counts,
                    )?;
                }
                write_applied_segment(&self.wal_dir, segment.id)?;
            }
            if text.is_some() {
                remove_if_exists(&segment.path)?;
            }
            self.status.pending_segments = self.status.pending_segments.saturating_sub(1);
            self.status.last_processed_at = Some(iso(now_ms()));
        }
        Ok(())
    }

    fn process_restores(&mut self) {
        while !self.restores.is_empty() && !self.stopping {
            let (path, reply) = self.restores.remove(0);
            self.checked_periods.clear();
            self.unsealed = None;
            let result = restore_backup_file(
                &self.options.data_dir,
                &path,
                now_ms(),
                self.options.seal_delay_ms,
            );
            let _ = reply.send(result);
        }
    }

    fn retry_held(&mut self) {
        let keys: Vec<(String, Option<String>)> = self
            .held
            .iter()
            .map(|(key, error)| (key.clone(), error.clone()))
            .collect();
        for (key, previous) in keys {
            if self.stopping {
                return;
            }
            let data_dir = self.options.data_dir.clone();
            let source = self.options.source.clone();
            match retry_held_day(&data_dir, &source, &key, &mut self.counts) {
                Ok(rows) => {
                    self.status.processed_rows += rows;
                    self.held.remove(&key);
                    logger::info(format!("Stored the records of {key} that were kept aside"));
                }
                Err(error) => {
                    if previous.as_deref() != Some(error.message.as_str()) {
                        logger::error(format!(
                            "Cannot store the kept records of {key} yet: {error}"
                        ));
                    }
                    self.held.insert(key, Some(error.message));
                }
            }
        }
    }

    fn keep_free_space(&mut self) {
        let Some(min_free) = self.options.min_free else {
            return;
        };
        match enforce_retention(
            &self.options.data_dir,
            min_free,
            self.options.usage.as_ref(),
            now_ms(),
        ) {
            Ok(result) => {
                self.status.disk = Some(
                    Object::new()
                        .with("totalBytes", result.usage.total_bytes)
                        .with("freeBytes", result.usage.free_bytes)
                        .with("neededBytes", result.needed_bytes)
                        .into(),
                );
                self.status.retention_error = None;
            }
            Err(error) => {
                if self.status.retention_error.as_deref() != Some(error.message.as_str()) {
                    logger::warn(format!("Retention check failed: {error}"));
                }
                self.status.retention_error = Some(error.message);
            }
        }
    }

    fn due(last: Option<i64>, every: i64) -> bool {
        last.is_none_or(|last| now_ms() - last >= every)
    }

    pub fn run(&mut self) {
        while !self.stopping {
            let mut stored = true;
            if Self::due(self.last_maintenance, self.options.maintenance_ms) {
                self.last_maintenance = Some(now_ms());
                self.keep_free_space();
            }
            match self.process_pending() {
                Ok(()) => self.status.last_error = None,
                Err(error) => {
                    logger::error(format!(
                        "Storage failed, retrying in {} s: {error}",
                        self.options.retry_ms / 1000
                    ));
                    self.status.last_error = Some(error.message);
                    stored = false;
                }
            }
            if !self.stopping
                && self.held_loaded
                && !self.held.is_empty()
                && Self::due(self.last_held_retry, self.options.maintenance_ms)
            {
                self.last_held_retry = Some(now_ms());
                self.retry_held();
            }
            self.process_restores();
            if !self.stopping && stored && Self::due(self.last_seal, self.options.maintenance_ms) {
                self.last_seal = Some(now_ms());
                let data_dir = self.options.data_dir.clone();
                let source = self.options.source.clone();
                if self.unsealed.is_none() {
                    self.counts.stored.clear();
                    match list_unsealed_days(&data_dir, &source) {
                        Ok(unsealed) => self.unsealed = Some(unsealed),
                        Err(error) => {
                            logger::error(format!("Cannot list the stored days: {error}"))
                        }
                    }
                }
                let stored_days = std::mem::take(&mut self.counts.stored);
                if let Some(unsealed) = self.unsealed.as_mut() {
                    unsealed.extend(stored_days);
                }
                let sealed = match self.unsealed.as_mut() {
                    Some(unsealed) => seal_due_days(
                        &data_dir,
                        &source,
                        now_ms(),
                        self.options.seal_delay_ms,
                        unsealed,
                    ),
                    None => Vec::new(),
                };
                for key in period_keys_of(&sealed) {
                    self.checked_periods.remove(&key);
                }
                seal_due_periods(
                    &data_dir,
                    &source,
                    now_ms(),
                    self.options.seal_delay_ms,
                    &mut self.checked_periods,
                );
            }
            *self
                .published
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(self.snapshot());
            if !self.stopping {
                self.sleep(if stored {
                    IDLE_MS
                } else {
                    self.options.retry_ms
                });
            }
        }
        for (_, reply) in self.restores.drain(..) {
            let _ = reply.send(Err(Error::status(503, "the server stops")));
        }
    }
}

pub struct StorageRunner {
    sender: Arc<Mutex<mpsc::Sender<Message>>>,
    status: Arc<Mutex<Option<Value>>>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
    stopping: Arc<std::sync::atomic::AtomicBool>,
}

impl StorageRunner {
    pub fn start(options: StorageOptions) -> Result<StorageRunner> {
        check_source(&options.source)?;
        let status = Arc::new(Mutex::new(None));
        let stopping = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let sender = Arc::new(Mutex::new(sender));
        let shared_sender = sender.clone();
        let published = status.clone();
        let stop_flag = stopping.clone();
        let supervisor = std::thread::Builder::new()
            .name("imp-aly-storage".to_string())
            .spawn(move || {
                let mut receiver = receiver;
                loop {
                    let wal_dir = join(&[&options.data_dir, "wal"]);
                    let mut storage = Storage {
                        options: options.clone(),
                        wal_dir,
                        receiver,
                        stopping: false,
                        woken: false,
                        last_maintenance: None,
                        last_seal: None,
                        last_held_retry: None,
                        held_loaded: false,
                        unsealed: None,
                        counts: Counts::default(),
                        held: BTreeMap::new(),
                        read_failures: HashMap::new(),
                        restores: Vec::new(),
                        checked_periods: HashSet::new(),
                        status: Status::default(),
                        published: published.clone(),
                    };
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        storage.run();
                    }));
                    if outcome.is_ok() {
                        return;
                    }
                    logger::error("The storage worker failed, it starts again in 5 s");
                    for (_, reply) in storage.restores.drain(..) {
                        let _ = reply.send(Err(Error::status(500, "the storage worker failed")));
                    }
                    let (next_sender, next_receiver) = mpsc::channel();
                    *shared_sender
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) = next_sender;
                    drop(storage);
                    receiver = next_receiver;
                    let mut waited = 0;
                    while waited < RESTART_MS {
                        if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                        waited += 100;
                    }
                }
            })
            .map_err(|error| Error::new(format!("cannot start the storage worker: {error}")))?;
        Ok(StorageRunner {
            sender,
            status,
            supervisor: Mutex::new(Some(supervisor)),
            stopping,
        })
    }

    fn send(&self, message: Message) -> bool {
        self.sender
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .send(message)
            .is_ok()
    }

    pub fn wake(&self) {
        self.send(Message::Wake);
    }

    pub fn waker(&self) -> impl Fn() + Send + Sync + 'static {
        let sender = self.sender.clone();
        move || {
            let _ = sender
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .send(Message::Wake);
        }
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
            .unwrap_or(Value::Null)
    }

    pub async fn restore(&self, path: String) -> std::result::Result<Value, Error> {
        let (reply, answer) = oneshot::channel();
        if !self.send(Message::Restore(path, reply)) {
            return Err(Error::status(
                503,
                "the storage worker is not running - try again later",
            ));
        }
        answer
            .await
            .unwrap_or_else(|_| Err(Error::status(500, "the storage worker failed")))
    }

    pub fn stop(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.send(Message::Stop);
        let supervisor = self
            .supervisor
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(supervisor) = supervisor {
            let started = std::time::Instant::now();
            while !supervisor.is_finished() && started.elapsed() < STOP_TIMEOUT {
                std::thread::sleep(Duration::from_millis(10));
            }
            if supervisor.is_finished() {
                let _ = supervisor.join();
            } else {
                logger::warn("The storage worker did not stop in 10 s");
            }
        }
    }
}

impl Drop for StorageRunner {
    fn drop(&mut self) {
        self.stop();
    }
}
