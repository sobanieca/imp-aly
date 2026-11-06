use crate::column_store::{
    DaySummary, Folders, SEALED_META_FILE, SealedMeta, SealedState, generations_of,
    read_sealed_meta, read_summary_text, sealed_dir,
};
use crate::days::now_ms;
use crate::error::{Error, Result};
use crate::fsutil::{Entry, Stamp, list_directory, stamp_of};
use crate::json::Value;
use crate::summary::{
    COUNT_DIMENSIONS, COUNT_MEASURES, VISIT_DIMENSIONS, for_each_visit_line, summary_file,
    table_lines,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

pub const QUERY_CACHE_BYTES: usize = 256 * 1024 * 1024;

pub const SETTLE_MS: i64 = 2_000;

const FOLDER_BYTES: usize = 256;

const ENTRY_BYTES: usize = 48;

const META_BYTES: usize = 512;

const MAX_DRAFTS: usize = 32;

pub const NO_VALUE: u32 = 0;

pub struct Draft {
    pub groups: Vec<(Vec<Option<String>>, u64, u64)>,
    pub scanned: u64,
    pub matched: u64,
}

impl Draft {
    fn size(&self, shape: &str) -> usize {
        ENTRY_BYTES
            + shape.len()
            + self
                .groups
                .iter()
                .map(|(parts, ..)| {
                    ENTRY_BYTES
                        + parts
                            .iter()
                            .map(|part| part.as_ref().map_or(0, String::len) + 24)
                            .sum::<usize>()
                })
                .sum::<usize>()
    }
}

pub struct IdTable {
    pub fields: Vec<String>,
    pub width: usize,
    pub cells: Vec<u32>,
}

impl IdTable {
    pub fn lines(&self) -> usize {
        self.cells.len().checked_div(self.width).unwrap_or(0)
    }

    pub fn row(&self, line: usize) -> &[u32] {
        &self.cells[line * self.width..(line + 1) * self.width]
    }

    pub fn position(&self, field: &str) -> Option<usize> {
        self.fields.iter().position(|name| name == field)
    }
}

pub struct ParsedSummary {
    pub rows: u64,
    pub wal: u64,
    pub days: Option<Value>,
    pub values: Vec<Box<str>>,
    pub counts: IdTable,
    pub records: Vec<u64>,
    pub tuples: IdTable,
    pub visit_counts: Vec<u64>,
    pub visit_ends: Vec<usize>,
    pub visit_tuples: Vec<usize>,
}

impl ParsedSummary {
    pub fn value(&self, id: u32) -> Option<&str> {
        if id == NO_VALUE {
            return None;
        }
        self.values.get(id as usize).map(|value| &**value)
    }

    pub fn visit_line(&self, line: usize) -> &[usize] {
        let start = if line == 0 {
            0
        } else {
            self.visit_ends[line - 1]
        };
        &self.visit_tuples[start..self.visit_ends[line]]
    }

    pub fn size(&self) -> usize {
        FOLDER_BYTES
            + self
                .values
                .iter()
                .map(|value| value.len() + 16)
                .sum::<usize>()
            + 4 * (self.counts.cells.len() + self.tuples.cells.len())
            + 8 * (self.records.len()
                + self.visit_counts.len()
                + self.visit_ends.len()
                + self.visit_tuples.len())
    }
}

pub struct Dictionary {
    ids: HashMap<Box<str>, u32>,
    values: Vec<Box<str>>,
}

impl Default for Dictionary {
    fn default() -> Self {
        Dictionary {
            ids: HashMap::new(),
            values: vec![Box::from("")],
        }
    }
}

impl Dictionary {
    pub fn id(&mut self, value: &str) -> u32 {
        if value.is_empty() {
            return NO_VALUE;
        }
        if let Some(id) = self.ids.get(value) {
            return *id;
        }
        let id = self.values.len() as u32;
        self.values.push(Box::from(value));
        self.ids.insert(Box::from(value), id);
        id
    }

    pub fn values(&self) -> &[Box<str>] {
        &self.values
    }

    pub fn into_values(self) -> Vec<Box<str>> {
        self.values
    }
}

fn id_table(
    text: &str,
    kind: &str,
    expected: &[String],
    measures: usize,
    dictionary: &mut Dictionary,
    mut on_measures: impl FnMut(&[&str]) -> Option<()>,
) -> Result<IdTable> {
    let invalid = |part: &str| {
        Error::new(format!(
            "{} has a {part} that is not valid",
            summary_file(kind)
        ))
    };
    let table = table_lines(text)?;
    if table.header.len() < expected.len() + measures || table.header[..expected.len()] != *expected
    {
        return Err(invalid("header"));
    }
    let width = table.header.len() - measures;
    let fields: Vec<String> = table.header[..width]
        .iter()
        .map(|field| field.to_string())
        .collect();
    let mut cells = Vec::with_capacity(table.lines.len() * width);
    for line in &table.lines {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != table.header.len() {
            return Err(invalid("line"));
        }
        for part in &parts[..width] {
            cells.push(dictionary.id(part));
        }
        on_measures(&parts[width..]).ok_or_else(|| invalid("line"))?;
    }
    Ok(IdTable {
        fields,
        width,
        cells,
    })
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| name.to_string()).collect()
}

pub fn parse_summary(summary: &DaySummary) -> Result<ParsedSummary> {
    let mut dictionary = Dictionary::default();
    let mut records = Vec::new();
    let mut total = 0u64;
    let count_header = names(&COUNT_DIMENSIONS);
    let counts = id_table(
        &summary.counts,
        "counts",
        &count_header,
        COUNT_MEASURES.len(),
        &mut dictionary,
        |measures| {
            let count = measures.first()?.parse::<u64>().ok().filter(|n| *n > 0)?;
            total = total.checked_add(count)?;
            records.push(count);
            Some(())
        },
    )?;
    if total != summary.rows {
        return Err(Error::new(format!(
            "{} counts {total} records, but {SEALED_META_FILE} counts {}",
            summary_file("counts"),
            summary.rows
        )));
    }
    let tuple_header: Vec<String> = names(&VISIT_DIMENSIONS)
        .into_iter()
        .chain(counts.fields[COUNT_DIMENSIONS.len()..].iter().cloned())
        .collect();
    let tuples = match summary.tuples.as_deref() {
        Some(text) => id_table(text, "tuples", &tuple_header, 0, &mut dictionary, |_| {
            Some(())
        })?,
        None => IdTable {
            fields: Vec::new(),
            width: 0,
            cells: Vec::new(),
        },
    };
    let tuple_lines = tuples.lines();
    let mut visit_counts = Vec::new();
    let mut visit_ends = Vec::new();
    let mut visit_tuples = Vec::new();
    let mut outside = false;
    for_each_visit_line(summary.visits.as_deref().unwrap_or(""), |visits, list| {
        outside |= list.iter().any(|index| *index >= tuple_lines);
        visit_counts.push(visits);
        visit_tuples.extend_from_slice(list);
        visit_ends.push(visit_tuples.len());
    })?;
    if outside {
        return Err(Error::new(format!(
            "{} points to a line that {} does not have",
            summary_file("visits"),
            summary_file("tuples")
        )));
    }
    Ok(ParsedSummary {
        rows: summary.rows,
        wal: summary.wal,
        days: summary.days.clone(),
        values: dictionary.into_values(),
        counts,
        records,
        tuples,
        visit_counts,
        visit_ends,
        visit_tuples,
    })
}

struct Folder {
    path: Arc<str>,
    stamp: Stamp,
    entries: Arc<Vec<Entry>>,
    meta: Option<(u64, Arc<SealedMeta>)>,
    summary: Option<(u64, Arc<ParsedSummary>)>,
    drafts: Vec<(String, Arc<Draft>, usize)>,
    size: usize,
    used: u64,
}

fn entries_size(entries: &[Entry]) -> usize {
    FOLDER_BYTES
        + entries
            .iter()
            .map(|entry| entry.name.len() + ENTRY_BYTES)
            .sum::<usize>()
}

fn meta_size(meta: &SealedMeta) -> usize {
    META_BYTES
        + meta
            .days()
            .and_then(Value::as_object)
            .map_or(0, |days| days.len() * ENTRY_BYTES)
}

struct Inner {
    limit: usize,
    settle_ms: i64,
    size: usize,
    clock: u64,
    folders: HashMap<String, Folder>,
    order: BTreeMap<u64, Arc<str>>,
}

impl Inner {
    fn remove(&mut self, path: &str) {
        if let Some(folder) = self.folders.remove(path) {
            self.size -= folder.size;
            self.order.remove(&folder.used);
        }
    }

    fn valid(&mut self, path: &str, stamp: Stamp) -> Option<&mut Folder> {
        if self
            .folders
            .get(path)
            .is_some_and(|folder| folder.stamp != stamp)
        {
            self.remove(path);
        }
        let folder = self.folders.get_mut(path)?;
        self.clock += 1;
        self.order.remove(&folder.used);
        folder.used = self.clock;
        self.order.insert(self.clock, folder.path.clone());
        Some(folder)
    }

    fn make_room(&mut self, keep: &str) {
        while self.size > self.limit {
            let Some((_, oldest)) = self
                .order
                .iter()
                .find(|(_, path)| &***path != keep)
                .map(|(used, path)| (*used, path.clone()))
            else {
                return;
            };
            self.remove(&oldest);
        }
    }

    fn grow(&mut self, path: &str, size: usize) {
        if let Some(folder) = self.folders.get_mut(path) {
            folder.size += size;
            self.size += size;
        }
        if self.size > self.limit {
            self.make_room(path);
        }
        if self.size > self.limit {
            self.remove(path);
        }
    }

    fn insert(&mut self, path: &str, stamp: Stamp, entries: Arc<Vec<Entry>>) {
        self.remove(path);
        let size = entries_size(&entries) + path.len();
        self.clock += 1;
        let shared: Arc<str> = Arc::from(path);
        self.folders.insert(
            path.to_string(),
            Folder {
                path: shared.clone(),
                stamp,
                entries,
                meta: None,
                summary: None,
                drafts: Vec::new(),
                size: 0,
                used: self.clock,
            },
        );
        self.order.insert(self.clock, shared);
        self.grow(path, size);
    }
}

pub struct QueryCache {
    inner: Mutex<Inner>,
}

pub struct View {
    pub stamp: Option<Stamp>,
    pub entries: Arc<Vec<Entry>>,
}

impl QueryCache {
    pub fn new(limit: usize, settle_ms: i64) -> Self {
        QueryCache {
            inner: Mutex::new(Inner {
                limit,
                settle_ms,
                size: 0,
                clock: 0,
                folders: HashMap::new(),
                order: BTreeMap::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn size(&self) -> usize {
        self.lock().size
    }

    pub fn view(&self, path: &str) -> Result<View> {
        let Some(stamp) = stamp_of(path)? else {
            self.lock().remove(path);
            return Ok(View {
                stamp: None,
                entries: Arc::new(Vec::new()),
            });
        };
        if let Some(folder) = self.lock().valid(path, stamp) {
            return Ok(View {
                stamp: Some(stamp),
                entries: folder.entries.clone(),
            });
        }
        let entries = Arc::new(list_directory(path)?);
        let settle_ms = self.lock().settle_ms;
        if stamp.settled(now_ms(), settle_ms) && stamp_of(path)? == Some(stamp) {
            self.lock().insert(path, stamp, entries.clone());
        }
        Ok(View {
            stamp: Some(stamp),
            entries,
        })
    }

    pub fn meta(&self, path: &str, stamp: Stamp, generation: u64) -> Result<Arc<SealedMeta>> {
        if let Some((cached, meta)) = self
            .lock()
            .valid(path, stamp)
            .and_then(|folder| folder.meta.clone())
            && cached == generation
        {
            return Ok(meta);
        }
        let meta = Arc::new(read_sealed_meta(&sealed_dir(path, generation))?);
        let mut inner = self.lock();
        if let Some(folder) = inner.valid(path, stamp)
            && folder.meta.is_none()
        {
            folder.meta = Some((generation, meta.clone()));
            inner.grow(path, meta_size(&meta));
        }
        Ok(meta)
    }

    pub fn summary(
        &self,
        path: &str,
        stamp: Stamp,
        generation: u64,
        meta: &SealedMeta,
    ) -> Result<(Arc<ParsedSummary>, bool)> {
        if let Some((cached, summary)) = self
            .lock()
            .valid(path, stamp)
            .and_then(|folder| folder.summary.clone())
            && cached == generation
        {
            return Ok((summary, true));
        }
        let dir = sealed_dir(path, generation);
        let summary = Arc::new(
            parse_summary(&read_summary_text(&dir, meta, true)?)
                .map_err(|error| error.context(format!("{dir}: ")))?,
        );
        let mut inner = self.lock();
        if let Some(folder) = inner.valid(path, stamp)
            && folder.summary.is_none()
        {
            folder.summary = Some((generation, summary.clone()));
            inner.grow(path, summary.size());
        }
        Ok((summary, false))
    }
}

impl QueryCache {
    pub fn draft(&self, path: &str, stamp: Stamp, shape: &str) -> Option<Arc<Draft>> {
        self.lock().valid(path, stamp).and_then(|folder| {
            folder
                .drafts
                .iter()
                .find(|(key, ..)| key == shape)
                .map(|(_, draft, _)| draft.clone())
        })
    }

    pub fn keep_draft(&self, path: &str, stamp: Stamp, shape: &str, draft: Arc<Draft>) {
        let mut inner = self.lock();
        let Some(folder) = inner.valid(path, stamp) else {
            return;
        };
        if folder.drafts.iter().any(|(key, ..)| key == shape) {
            return;
        }
        let mut freed = 0;
        if folder.drafts.len() == MAX_DRAFTS {
            freed = folder.drafts.remove(0).2;
        }
        let size = draft.size(shape);
        folder.drafts.push((shape.to_string(), draft, size));
        folder.size -= freed;
        inner.size -= freed;
        inner.grow(path, size);
    }
}

impl Folders for QueryCache {
    fn entries(&self, path: &str) -> Result<Arc<Vec<Entry>>> {
        Ok(self.view(path)?.entries)
    }

    fn sealed_state(&self, path: &str) -> Result<SealedState> {
        let view = self.view(path)?;
        let generations = generations_of(&view.entries);
        let meta = match view.stamp {
            Some(stamp) if generations.sealed > 0 && generations.raws.is_empty() => {
                Some(self.meta(path, stamp, generations.sealed))
            }
            _ => None,
        };
        Ok(SealedState { generations, meta })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    const COUNTS: &str = "type\tpage\tzone\tname\tcountry\trecords\npage\t/\t\t\tPL\t3\n";

    const TUPLES: &str = "type\tpage\tcountry\npage\t/\tPL\n";

    fn parsed(rows: u64, counts: &str, tuples: &str, visits: &str) -> Result<ParsedSummary> {
        parse_summary(&DaySummary {
            rows,
            wal: 0,
            days: None,
            counts: counts.to_string(),
            tuples: Some(tuples.to_string()),
            visits: Some(visits.to_string()),
        })
    }

    #[test]
    fn a_parsed_summary_keeps_each_cell_as_an_id_of_one_dictionary() {
        let summary = parsed(3, COUNTS, TUPLES, "visits\ttuples\n2\t0\n").unwrap();
        assert_eq!(
            summary.counts.fields,
            ["type", "page", "zone", "name", "country"]
        );
        assert_eq!(summary.records, [3]);
        let row = summary.counts.row(0);
        assert_eq!(summary.value(row[0]), Some("page"));
        assert_eq!(summary.value(row[2]), None);
        assert_eq!(summary.tuples.row(0)[1], row[1]);
        assert_eq!(
            (summary.visit_counts[0], summary.visit_line(0)),
            (2, &[0][..])
        );
    }

    #[test]
    fn a_damaged_summary_fails_to_parse() {
        let visits = "visits\ttuples\n2\t0\n";
        let damaged = [
            (3, "x\u{1}garbage\n", TUPLES, visits),
            (
                3,
                "type\tpage\tzone\tname\trecords\npage\t/\t\t\t3\n",
                TUPLES,
                visits,
            ),
            (
                3,
                "type\tpage\tzone\tname\tcountry\trecords\npage\t/\t\tPL\t3\n",
                TUPLES,
                visits,
            ),
            (
                3,
                "type\tpage\tzone\tname\tcountry\trecords\npage\t/\t\t\tPL\tx\n",
                TUPLES,
                visits,
            ),
            (
                0,
                "type\tpage\tzone\tname\tcountry\trecords\npage\t/\t\t\tPL\t0\n",
                TUPLES,
                visits,
            ),
            (4, COUNTS, TUPLES, visits),
            (3, COUNTS, "type\tpage\npage\t/\n", visits),
            (3, COUNTS, "type\tpage\tcountry\npage\t/\n", visits),
            (3, COUNTS, TUPLES, "visits\ttuples\n2\t1\n"),
            (3, COUNTS, TUPLES, "visits\ttuples\n2\n"),
        ];
        for (index, (rows, counts, tuples, visits)) in damaged.into_iter().enumerate() {
            assert!(
                parsed(rows, counts, tuples, visits).is_err(),
                "case {index}"
            );
        }
    }

    fn settled_folders(count: usize) -> (TempDir, Vec<String>) {
        let dir = TempDir::new();
        let paths: Vec<String> = (0..count)
            .map(|index| {
                let path = dir.join(&format!("f{index}"));
                std::fs::create_dir_all(format!("{path}/sealed-1")).unwrap();
                path
            })
            .collect();
        (dir, paths)
    }

    #[test]
    fn the_cache_keeps_only_settled_folders_and_drops_the_least_recently_used() {
        let (_dir, paths) = settled_folders(3);
        let cache = QueryCache::new(usize::MAX, SETTLE_MS);
        cache.view(&paths[0]).unwrap();
        assert_eq!(cache.size(), 0);
        let one = entries_size(&list_directory(&paths[0]).unwrap()) + paths[0].len();
        let mut inner = cache.lock();
        inner.limit = 2 * one;
        for path in &paths {
            let stamp = stamp_of(path).unwrap().unwrap();
            inner.insert(path, stamp, Arc::new(list_directory(path).unwrap()));
        }
        assert!(!inner.folders.contains_key(&paths[0]));
        assert!(inner.folders.contains_key(&paths[2]));
        assert!(inner.size <= inner.limit);
        let changed = stamp_of(&paths[1]).unwrap().unwrap();
        drop(inner);
        std::fs::create_dir(format!("{}/raw-2", paths[1])).unwrap();
        let mut inner = cache.lock();
        let now = stamp_of(&paths[1]).unwrap().unwrap();
        assert_ne!(now, changed);
        assert!(inner.valid(&paths[1], now).is_none());
        assert!(!inner.folders.contains_key(&paths[1]));
    }
}
