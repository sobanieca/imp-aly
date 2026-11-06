use crate::column_store::{
    read_commit, read_day_parts, read_generations, read_sealed_meta, sealed_dir,
};
use crate::error::Result;
use crate::fast_hash::FastMap;
use crate::json::{Object, Value, format_number};
use crate::names::BASE_COLUMNS;
use crate::paths::join;
use crate::query_cache::{Dictionary, IdTable, NO_VALUE, ParsedSummary};
use crate::rle::Cell;
use crate::summary::{COUNT_DIMENSIONS, VISIT_DIMENSIONS};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

const BLOCK_ROWS: usize = 65_536;

const ROW_FIELDS: [&str; 6] = ["type", "page", "zone", "name", "country", "visit"];

const COUNT_AT: [usize; 5] = [0, 1, 2, 3, 4];

const TUPLE_AT: [usize; 3] = [0, 1, 4];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiskState {
    sealed: u64,
    sealed_rows: u64,
    raws: Vec<(u64, u64, u64)>,
}

impl DiskState {
    pub fn rows(&self) -> u64 {
        self.sealed_rows + self.raws.iter().map(|(_, rows, _)| rows).sum::<u64>()
    }

    pub fn wal(&self) -> u64 {
        self.raws.iter().map(|(_, _, wal)| *wal).max().unwrap_or(0)
    }

    pub fn is_open(&self) -> bool {
        !self.raws.is_empty()
    }
}

pub fn disk_state(path: &str) -> Result<DiskState> {
    let generations = read_generations(path)?;
    let sealed_rows = if generations.sealed > 0 {
        read_sealed_meta(&sealed_dir(path, generations.sealed))?.rows
    } else {
        0
    };
    let mut raws = Vec::new();
    for generation in &generations.raws {
        let commit = read_commit(&join(&[path, &format!("raw-{generation}")]))?;
        raws.push((*generation, commit.rows, commit.wal));
    }
    Ok(DiskState {
        sealed: generations.sealed,
        sealed_rows,
        raws,
    })
}

fn trimmed(key: &mut Vec<u32>) {
    while key.last() == Some(&NO_VALUE) {
        key.pop();
    }
}

#[derive(Default)]
pub struct LiveSummary {
    values: Dictionary,
    visits: Dictionary,
    segments: Vec<String>,
    count_index: FastMap<Vec<u32>, usize>,
    counts: Vec<(Vec<u32>, u64)>,
    tuple_index: FastMap<Vec<u32>, u32>,
    tuples: Vec<Vec<u32>>,
    visit_sets: Vec<Vec<u32>>,
    rows: u64,
}

impl LiveSummary {
    fn segment_slot(&mut self, name: &str) -> usize {
        match self.segments.iter().position(|segment| segment == name) {
            Some(slot) => slot,
            None => {
                self.segments.push(name.to_string());
                self.segments.len() - 1
            }
        }
    }

    pub fn add_row(&mut self, base: [&str; 6], segments: &[(&str, &str)]) {
        let ids: Vec<u32> = base[..5]
            .iter()
            .map(|value| self.values.id(value))
            .collect();
        let mut slots = vec![NO_VALUE; self.segments.len()];
        for (name, value) in segments {
            if value.is_empty() {
                continue;
            }
            let slot = self.segment_slot(name);
            if slot >= slots.len() {
                slots.resize(slot + 1, NO_VALUE);
            }
            slots[slot] = self.values.id(value);
        }
        let mut count_key: Vec<u32> = COUNT_AT.iter().map(|at| ids[*at]).collect();
        count_key.extend_from_slice(&slots);
        trimmed(&mut count_key);
        let next = self.counts.len();
        let at = *self.count_index.entry(count_key.clone()).or_insert(next);
        if at == next {
            self.counts.push((count_key, 0));
        }
        self.counts[at].1 += 1;
        let mut tuple_key: Vec<u32> = TUPLE_AT.iter().map(|at| ids[*at]).collect();
        tuple_key.extend_from_slice(&slots);
        trimmed(&mut tuple_key);
        let next = self.tuples.len() as u32;
        let tuple = *self.tuple_index.entry(tuple_key.clone()).or_insert(next);
        if tuple == next {
            self.tuples.push(tuple_key);
        }
        self.rows += 1;
        let visit = self.visits.id(base[5]);
        if visit == NO_VALUE {
            return;
        }
        let visit = visit as usize;
        if visit >= self.visit_sets.len() {
            self.visit_sets.resize(visit + 1, Vec::new());
        }
        let set = &mut self.visit_sets[visit];
        if let Err(at) = set.binary_search(&tuple) {
            set.insert(at, tuple);
        }
    }

    pub fn add_records(&mut self, records: &[Object]) {
        let text = |value: Option<&Value>| match value {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(number)) => format_number(*number),
            _ => String::new(),
        };
        for record in records {
            let base = ROW_FIELDS.map(|field| text(record.get(field)));
            let segments: Vec<(&str, String)> = record
                .iter()
                .filter(|(key, _)| !BASE_COLUMNS.contains(&key.as_str()))
                .map(|(key, value)| (key.as_str(), text(Some(value))))
                .collect();
            let pairs: Vec<(&str, &str)> = segments
                .iter()
                .map(|(key, value)| (*key, value.as_str()))
                .collect();
            self.add_row(base.each_ref().map(String::as_str), &pairs);
        }
    }

    fn table(&self, fields: &[&str], lines: &mut dyn Iterator<Item = &Vec<u32>>) -> IdTable {
        let fields: Vec<String> = fields
            .iter()
            .map(|field| field.to_string())
            .chain(self.segments.iter().cloned())
            .collect();
        let width = fields.len();
        let mut cells = Vec::new();
        for key in lines {
            cells.extend_from_slice(key);
            cells.resize(cells.len() + width - key.len(), NO_VALUE);
        }
        IdTable {
            fields,
            width,
            cells,
        }
    }

    pub fn snapshot(&self, wal: u64) -> ParsedSummary {
        let counts = self.table(
            &COUNT_DIMENSIONS,
            &mut self.counts.iter().map(|(key, _)| key),
        );
        let tuples = self.table(&VISIT_DIMENSIONS, &mut self.tuples.iter());
        let mut grouped: FastMap<&[u32], usize> = FastMap::default();
        let mut visit_counts: Vec<u64> = Vec::new();
        let mut sets: Vec<&[u32]> = Vec::new();
        for set in self.visit_sets.iter().filter(|set| !set.is_empty()) {
            let next = sets.len();
            let at = *grouped.entry(set.as_slice()).or_insert(next);
            if at == next {
                sets.push(set.as_slice());
                visit_counts.push(0);
            }
            visit_counts[at] += 1;
        }
        let mut visit_ends = Vec::with_capacity(sets.len());
        let mut visit_tuples = Vec::new();
        for set in sets {
            visit_tuples.extend(set.iter().map(|tuple| *tuple as usize));
            visit_ends.push(visit_tuples.len());
        }
        ParsedSummary {
            rows: self.rows,
            wal,
            days: None,
            values: self.values.values().to_vec(),
            counts,
            records: self.counts.iter().map(|(_, records)| *records).collect(),
            tuples,
            visit_counts,
            visit_ends,
            visit_tuples,
        }
    }
}

fn cell(cells: &[Cell], row: usize) -> &str {
    cells[row].as_deref().unwrap_or("")
}

pub fn build_from_disk(path: &str) -> Result<(LiveSummary, DiskState)> {
    let state = disk_state(path)?;
    let generations = read_generations(path)?;
    let mut summary = LiveSummary::default();
    for part in read_day_parts(path, &generations)? {
        let segments: Vec<&String> = part
            .columns
            .iter()
            .filter(|column| !BASE_COLUMNS.contains(&column.as_str()))
            .collect();
        let mut base = Vec::new();
        for field in ROW_FIELDS {
            base.push(part.open(field)?);
        }
        let mut extra = Vec::new();
        for segment in &segments {
            extra.push(part.open(segment)?);
        }
        let mut left = part.rows as usize;
        while left > 0 {
            let size = left.min(BLOCK_ROWS);
            let mut base_cells = Vec::new();
            for source in base.iter_mut() {
                base_cells.push(source.take(size)?);
            }
            let mut extra_cells = Vec::new();
            for source in extra.iter_mut() {
                extra_cells.push(source.take(size)?);
            }
            for row in 0..size {
                let values: [&str; 6] = std::array::from_fn(|at| cell(&base_cells[at], row));
                let pairs: Vec<(&str, &str)> = segments
                    .iter()
                    .zip(&extra_cells)
                    .map(|(name, cells)| (name.as_str(), cell(cells, row)))
                    .collect();
                summary.add_row(values, &pairs);
            }
            left -= size;
        }
        for source in base.iter_mut().chain(extra.iter_mut()) {
            source.finish()?;
        }
    }
    Ok((summary, state))
}

struct LiveDay {
    state: DiskState,
    summary: LiveSummary,
    snapshot: Option<Arc<ParsedSummary>>,
}

#[derive(Default)]
pub struct LiveDays {
    days: Mutex<HashMap<String, LiveDay>>,
}

impl LiveDays {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, LiveDay>> {
        self.days
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    pub fn remove(&self, path: &str) {
        self.lock().remove(path);
    }

    pub fn keep_only(&self, paths: &[String]) {
        self.lock().retain(|path, _| paths.contains(path));
    }

    pub fn has(&self, path: &str) -> bool {
        self.lock().contains_key(path)
    }

    pub fn holds(&self, path: &str, state: &DiskState) -> bool {
        self.lock().get(path).is_some_and(|day| &day.state == state)
    }

    pub fn put(&self, path: &str, summary: LiveSummary, state: DiskState) {
        self.lock().insert(
            path.to_string(),
            LiveDay {
                state,
                summary,
                snapshot: None,
            },
        );
    }

    pub fn add(&self, path: &str, before: &DiskState, after: DiskState, records: &[Object]) {
        let mut days = self.lock();
        if before.rows() == 0 {
            days.insert(
                path.to_string(),
                LiveDay {
                    state: before.clone(),
                    summary: LiveSummary::default(),
                    snapshot: None,
                },
            );
        }
        let Some(day) = days.get_mut(path) else {
            return;
        };
        if &day.state != before {
            days.remove(path);
            return;
        }
        day.summary.add_records(records);
        day.state = after;
        day.snapshot = None;
    }

    pub fn summary(&self, path: &str, state: &DiskState) -> Option<Arc<ParsedSummary>> {
        let mut days = self.lock();
        let day = days.get_mut(path)?;
        if &day.state != state {
            return None;
        }
        if day.snapshot.is_none() {
            day.snapshot = Some(Arc::new(day.summary.snapshot(state.wal())));
        }
        day.snapshot.clone()
    }
}
