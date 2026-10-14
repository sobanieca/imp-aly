use crate::days::now_ms;
use crate::error::{Error, Result};
use crate::fsutil::{create_dir_all, list_directory, read_text, sync_directory, write_file_atomic};
use crate::logger;
use crate::paths::join;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::sync::Mutex;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub const APPLIED_FILE: &str = "applied";

pub const DEFAULT_SEGMENT_MS: u64 = 2_000;

pub const DEFAULT_SEGMENT_BYTES: u64 = 8_388_608;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extension {
    Log,
    Open,
}

pub struct SegmentName {
    pub id: u64,
    pub valid_bytes: Option<u64>,
    pub extension: Extension,
}

pub fn parse_segment_name(name: &str) -> Option<SegmentName> {
    let (stem, extension) = match name.strip_suffix(".log") {
        Some(stem) => (stem, Extension::Log),
        None => (name.strip_suffix(".open")?, Extension::Open),
    };
    let (id, valid) = match stem.split_once('-') {
        Some((id, valid)) => (id, Some(valid)),
        None => (stem, None),
    };
    if id.len() != 16 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let valid_bytes = match valid {
        None => None,
        Some(digits) => {
            if digits.is_empty() || digits.len() > 18 || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            Some(digits.parse().ok()?)
        }
    };
    Some(SegmentName {
        id: id.parse().ok()?,
        valid_bytes,
        extension,
    })
}

pub fn segment_file_name(id: u64, extension: Extension, valid_bytes: Option<u64>) -> String {
    let extension = match extension {
        Extension::Log => "log",
        Extension::Open => "open",
    };
    match valid_bytes {
        Some(valid) => format!("{id:016}-{valid}.{extension}"),
        None => format!("{id:016}.{extension}"),
    }
}

pub fn read_applied_segment(wal_dir: &str) -> Result<u64> {
    Ok(read_text(&join(&[wal_dir, APPLIED_FILE]))?
        .and_then(|text| text.trim().parse::<u64>().ok())
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .unwrap_or(0))
}

pub fn write_applied_segment(wal_dir: &str, id: u64) -> Result<()> {
    write_file_atomic(
        &join(&[wal_dir, APPLIED_FILE]),
        format!("{id}\n").as_bytes(),
    )
}

pub struct ClosedSegment {
    pub id: u64,
    pub path: String,
    pub valid_bytes: Option<u64>,
}

pub fn list_closed_segments(wal_dir: &str) -> Result<Vec<ClosedSegment>> {
    let mut segments = Vec::new();
    for entry in list_directory(wal_dir)? {
        if !entry.is_file {
            continue;
        }
        if let Some(name) = parse_segment_name(&entry.name)
            && name.extension == Extension::Log
        {
            segments.push(ClosedSegment {
                id: name.id,
                path: join(&[wal_dir, &entry.name]),
                valid_bytes: name.valid_bytes,
            });
        }
    }
    segments.sort_by_key(|segment| segment.id);
    Ok(segments)
}

type Reply = oneshot::Sender<std::result::Result<(), String>>;

enum Message {
    Append(String, Reply),
    Close(std::sync::mpsc::Sender<()>),
}

pub struct WalOptions {
    pub dir: String,
    pub segment_ms: u64,
    pub segment_bytes: u64,
    pub on_segment: Box<dyn Fn(u64) + Send>,
}

pub struct Wal {
    sender: Mutex<mpsc::Sender<Message>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

struct Writer {
    dir: String,
    segment_bytes: u64,
    on_segment: Box<dyn Fn(u64) + Send>,
    last_id: u64,
    file: Option<File>,
    file_id: u64,
    size: u64,
    broken: bool,
}

impl Writer {
    fn open_segment(&mut self) -> Result<()> {
        self.file_id = (self.last_id + 1).max(now_ms() as u64);
        self.last_id = self.file_id;
        let path = join(&[
            &self.dir,
            &segment_file_name(self.file_id, Extension::Open, None),
        ]);
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| Error::io(&error, &path))?;
        sync_directory(&self.dir)?;
        self.file = Some(file);
        self.size = 0;
        self.broken = false;
        Ok(())
    }

    fn close_segment(&mut self) -> Result<()> {
        if self.file.is_none() {
            return Ok(());
        }
        let open_path = join(&[
            &self.dir,
            &segment_file_name(self.file_id, Extension::Open, None),
        ]);
        let stored = self.broken || self.size > 0;
        if self.broken {
            let target = segment_file_name(self.file_id, Extension::Log, Some(self.size));
            fs::rename(&open_path, join(&[&self.dir, &target]))
                .map_err(|error| Error::io(&error, &open_path))?;
        } else if stored {
            let target = segment_file_name(self.file_id, Extension::Log, None);
            fs::rename(&open_path, join(&[&self.dir, &target]))
                .map_err(|error| Error::io(&error, &open_path))?;
        } else {
            fs::remove_file(&open_path).map_err(|error| Error::io(&error, &open_path))?;
        }
        self.file = None;
        self.size = 0;
        self.broken = false;
        if stored {
            (self.on_segment)(self.file_id);
        }
        Ok(())
    }

    fn warn_close(&self, error: &Error) {
        logger::error(format!(
            "Cannot close log part {}, the server tries again later: {error}",
            self.file_id
        ));
    }

    fn write_batch(&mut self, text: &str) -> Result<()> {
        if self.broken {
            self.close_segment()?;
        }
        if self.file.is_none() {
            self.open_segment()?;
        }
        let start = self.size;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| Error::new("the log part is not open"))?;
        let written = file
            .write_all(text.as_bytes())
            .and_then(|()| file.sync_data());
        if let Err(error) = written {
            let restored = file
                .set_len(start)
                .and_then(|()| file.seek(SeekFrom::Start(start)).map(|_| ()));
            self.broken = restored.is_err();
            if let Err(close) = self.close_segment() {
                self.warn_close(&close);
            }
            return Err(Error::from(error));
        }
        self.size += text.len() as u64;
        if self.size >= self.segment_bytes
            && let Err(error) = self.close_segment()
        {
            self.warn_close(&error);
        }
        Ok(())
    }

    fn flush(&mut self, batch: Vec<(String, Reply)>) {
        if batch.is_empty() {
            return;
        }
        let text: String = batch.iter().map(|(text, _)| text.as_str()).collect();
        let result = self.write_batch(&text).map_err(|error| error.message);
        for (_, reply) in batch {
            let _ = reply.send(result.clone());
        }
    }

    fn tick(&mut self) {
        if self.file.is_some()
            && (self.size > 0 || self.broken)
            && let Err(error) = self.close_segment()
        {
            self.warn_close(&error);
        }
    }

    fn close(&mut self) {
        if let Err(error) = self.close_segment() {
            logger::error(format!(
                "Cannot close log part {}, the next start stores it: {error}",
                self.file_id
            ));
            self.file = None;
        }
    }
}

impl Wal {
    pub fn open(options: WalOptions) -> Result<Wal> {
        create_dir_all(&options.dir)?;
        let mut last_id = read_applied_segment(&options.dir)?;
        for entry in list_directory(&options.dir)? {
            let Some(name) = parse_segment_name(&entry.name) else {
                continue;
            };
            if !entry.is_file {
                continue;
            }
            last_id = last_id.max(name.id);
            if name.extension == Extension::Open {
                let from = join(&[&options.dir, &entry.name]);
                let to = join(&[
                    &options.dir,
                    &segment_file_name(name.id, Extension::Log, None),
                ]);
                fs::rename(&from, &to).map_err(|error| Error::io(&error, &from))?;
            }
        }
        let (sender, receiver) = mpsc::channel::<Message>();
        let segment_ms = options.segment_ms.max(1);
        let mut writer = Writer {
            dir: options.dir,
            segment_bytes: options.segment_bytes,
            on_segment: options.on_segment,
            last_id,
            file: None,
            file_id: 0,
            size: 0,
            broken: false,
        };
        let thread = std::thread::Builder::new()
            .name("imp-aly-wal".to_string())
            .spawn(move || {
                let period = Duration::from_millis(segment_ms);
                let mut next_tick = Instant::now() + period;
                loop {
                    let wait = next_tick.saturating_duration_since(Instant::now());
                    match receiver.recv_timeout(wait) {
                        Ok(Message::Append(text, reply)) => {
                            let mut batch = vec![(text, reply)];
                            let mut closing = None;
                            while let Ok(message) = receiver.try_recv() {
                                match message {
                                    Message::Append(text, reply) => batch.push((text, reply)),
                                    Message::Close(done) => {
                                        closing = Some(done);
                                        break;
                                    }
                                }
                            }
                            writer.flush(batch);
                            if let Some(done) = closing {
                                writer.close();
                                let _ = done.send(());
                                return;
                            }
                        }
                        Ok(Message::Close(done)) => {
                            writer.close();
                            let _ = done.send(());
                            return;
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            writer.tick();
                            next_tick = Instant::now() + period;
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            writer.close();
                            return;
                        }
                    }
                    if Instant::now() >= next_tick {
                        writer.tick();
                        next_tick = Instant::now() + period;
                    }
                }
            })
            .map_err(|error| Error::new(format!("cannot start the write-ahead log: {error}")))?;
        Ok(Wal {
            sender: Mutex::new(sender),
            thread: Mutex::new(Some(thread)),
        })
    }

    fn send(&self, message: Message) -> std::result::Result<(), ()> {
        self.sender
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .send(message)
            .map_err(|_| ())
    }

    pub async fn append(&self, text: String) -> std::result::Result<(), String> {
        let (reply, answer) = oneshot::channel();
        self.send(Message::Append(text, reply))
            .map_err(|_| "the write-ahead log is closed".to_string())?;
        answer
            .await
            .map_err(|_| "the write-ahead log is closed".to_string())?
    }

    pub fn append_blocking(&self, text: String) -> std::result::Result<(), String> {
        let (reply, answer) = oneshot::channel();
        self.send(Message::Append(text, reply))
            .map_err(|_| "the write-ahead log is closed".to_string())?;
        answer
            .blocking_recv()
            .map_err(|_| "the write-ahead log is closed".to_string())?
    }

    pub fn close(&self) {
        self.close_shared();
    }

    pub fn close_shared(&self) {
        let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        else {
            return;
        };
        let (done, wait) = mpsc::channel();
        if self.send(Message::Close(done)).is_ok() {
            let _ = wait.recv();
        }
        let _ = thread.join();
    }
}

impl Drop for Wal {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::sync::{Arc, Mutex};

    fn names(dir: &str) -> Vec<String> {
        let mut names: Vec<String> = list_directory(dir)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort();
        names
    }

    fn open(dir: &str, segment_ms: u64, segment_bytes: u64) -> (Wal, Arc<Mutex<Vec<u64>>>) {
        let closed = Arc::new(Mutex::new(Vec::new()));
        let seen = closed.clone();
        let wal = Wal::open(WalOptions {
            dir: dir.to_string(),
            segment_ms,
            segment_bytes,
            on_segment: Box::new(move |id| seen.lock().unwrap().push(id)),
        })
        .unwrap();
        (wal, closed)
    }

    #[test]
    fn appends_are_grouped_and_segments_close_on_rotation() {
        let dir = TempDir::new();
        let (wal, closed) = open(&dir.path, 60_000, DEFAULT_SEGMENT_BYTES);
        for line in ["a\n", "b\n", "c\n"] {
            wal.append_blocking(line.to_string()).unwrap();
        }
        assert!(closed.lock().unwrap().is_empty());
        wal.close();
        assert_eq!(closed.lock().unwrap().len(), 1);
        let segments = list_closed_segments(&dir.path).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(fs::read_to_string(&segments[0].path).unwrap(), "a\nb\nc\n");
        assert!(wal.append_blocking("d\n".to_string()).is_err());
    }

    #[test]
    fn a_full_segment_closes_and_the_next_one_starts() {
        let dir = TempDir::new();
        let (wal, closed) = open(&dir.path, 60_000, 4);
        wal.append_blocking("abcd\n".to_string()).unwrap();
        wal.append_blocking("e\n".to_string()).unwrap();
        wal.close();
        assert_eq!(closed.lock().unwrap().len(), 2);
        assert_eq!(list_closed_segments(&dir.path).unwrap().len(), 2);
    }

    #[test]
    fn an_open_segment_of_a_crash_is_closed_and_ids_never_repeat() {
        let dir = TempDir::new();
        let future = now_ms() as u64 + 10_000_000;
        fs::write(
            dir.join(&segment_file_name(future, Extension::Open, None)),
            "x\n",
        )
        .unwrap();
        let (wal, _) = open(&dir.path, 60_000, DEFAULT_SEGMENT_BYTES);
        wal.append_blocking("y\n".to_string()).unwrap();
        wal.close();
        let segments = list_closed_segments(&dir.path).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].id, future);
        assert_eq!(segments[1].id, future + 1);
    }

    #[test]
    fn ids_follow_the_clock_so_an_empty_folder_never_repeats_an_old_id() {
        let dir = TempDir::new();
        write_applied_segment(&dir.path, 5).unwrap();
        let (wal, closed) = open(&dir.path, 60_000, DEFAULT_SEGMENT_BYTES);
        wal.append_blocking("a\n".to_string()).unwrap();
        wal.close();
        assert!(closed.lock().unwrap()[0] >= now_ms() as u64 - 60_000);
    }

    #[test]
    fn a_part_named_with_a_size_keeps_only_the_bytes_before_it() {
        let name = parse_segment_name("0001759000000000-12.log").unwrap();
        assert_eq!((name.id, name.valid_bytes), (1_759_000_000_000, Some(12)));
        assert!(parse_segment_name("123.log").is_none());
        assert!(parse_segment_name("0001759000000000.txt").is_none());
    }

    #[test]
    fn the_timer_closes_a_segment_with_data() {
        let dir = TempDir::new();
        let (wal, closed) = open(&dir.path, 20, DEFAULT_SEGMENT_BYTES);
        wal.append_blocking("a\n".to_string()).unwrap();
        let start = Instant::now();
        while closed.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(closed.lock().unwrap().len(), 1);
        assert_eq!(names(&dir.path).len(), 1);
        wal.close();
    }
}
