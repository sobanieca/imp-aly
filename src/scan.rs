use crate::column_store::{
    ColumnFile, Generations, Part, READ_ATTEMPTS, pause, read_day_parts, read_generations,
};
use crate::error::{Error, Result};
use crate::fast_hash::{FastMap, IdKeys};
use crate::line_files::LineBlocks;
use crate::query_cache::{Draft, NO_VALUE};
use crate::query_core::{Filter, Query, group_parts};
use crate::rle::parse_run_bytes;

pub const BLOCK_ROWS: usize = 65_536;

const COMPACT_PAIRS: usize = 4_194_304;

fn compact(pairs: &mut Vec<u64>) {
    pairs.sort_unstable();
    pairs.dedup();
}

const INLINE_BYTES: usize = 7;

fn inline_key(value: &[u8]) -> Option<u64> {
    if value.len() > INLINE_BYTES {
        return None;
    }
    let mut word = [0u8; 8];
    word[..value.len()].copy_from_slice(value);
    word[7] = value.len() as u8;
    Some(u64::from_le_bytes(word))
}

pub struct ColumnDictionary {
    short: FastMap<u64, u32>,
    ids: FastMap<Box<[u8]>, u32>,
    values: Vec<Box<[u8]>>,
    keep_values: bool,
    last: Vec<u8>,
    last_id: u32,
}

impl ColumnDictionary {
    pub fn new(keep_values: bool) -> Self {
        ColumnDictionary {
            short: FastMap::default(),
            ids: FastMap::default(),
            values: vec![Box::from(&b""[..])],
            keep_values,
            last: Vec::new(),
            last_id: NO_VALUE,
        }
    }

    pub fn id(&mut self, value: &[u8]) -> u32 {
        if value.is_empty() {
            return NO_VALUE;
        }
        if self.last_id != NO_VALUE && self.last == value {
            return self.last_id;
        }
        let short = inline_key(value);
        let found = match short {
            Some(key) => self.short.get(&key),
            None => self.ids.get(value),
        };
        let id = match found {
            Some(id) => *id,
            None => {
                let id = (self.short.len() + self.ids.len()) as u32 + 1;
                match short {
                    Some(key) => {
                        self.short.insert(key, id);
                    }
                    None => {
                        self.ids.insert(Box::from(value), id);
                    }
                }
                if self.keep_values {
                    self.values.push(Box::from(value));
                }
                id
            }
        };
        self.last.clear();
        self.last.extend_from_slice(value);
        self.last_id = id;
        id
    }

    pub fn len(&self) -> usize {
        self.short.len() + self.ids.len() + 1
    }

    pub fn is_empty(&self) -> bool {
        self.short.is_empty() && self.ids.is_empty()
    }

    pub fn text(&self, id: u32) -> Option<String> {
        if id == NO_VALUE {
            return None;
        }
        self.values
            .get(id as usize)
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    }
}

enum Lines {
    Missing,
    Plain(LineBlocks),
    Runs(LineBlocks),
}

pub struct ColumnReader {
    lines: Lines,
    run: (u32, u64),
}

fn fewer_rows(path: &str) -> Error {
    Error::new(format!("{path} holds fewer rows than expected"))
}

fn more_rows(path: &str) -> Error {
    Error::new(format!("{path} holds more rows than expected"))
}

fn push_run(runs: &mut Vec<(u32, u32)>, id: u32, count: u32) {
    match runs.last_mut() {
        Some(last) if last.0 == id => last.1 += count,
        _ => runs.push((id, count)),
    }
}

impl ColumnReader {
    pub fn open(file: ColumnFile) -> Result<ColumnReader> {
        let lines = match file {
            ColumnFile::Missing => Lines::Missing,
            ColumnFile::Plain { path, max_bytes } => {
                Lines::Plain(LineBlocks::open(&path, max_bytes)?)
            }
            ColumnFile::Runs { path } => Lines::Runs(LineBlocks::open(&path, None)?),
        };
        Ok(ColumnReader {
            lines,
            run: (NO_VALUE, 0),
        })
    }

    pub fn read(
        &mut self,
        rows: usize,
        dictionary: &mut ColumnDictionary,
        runs: &mut Vec<(u32, u32)>,
    ) -> Result<()> {
        runs.clear();
        match &mut self.lines {
            Lines::Missing => runs.push((NO_VALUE, rows as u32)),
            Lines::Plain(lines) => {
                for _ in 0..rows {
                    let line = match lines.next_line()? {
                        Some(line) => line,
                        None => return Err(fewer_rows(lines.path())),
                    };
                    push_run(runs, dictionary.id(line), 1);
                }
            }
            Lines::Runs(lines) => {
                let mut need = rows as u64;
                while need > 0 {
                    if self.run.1 == 0 {
                        let line = match lines.next_line()? {
                            Some(line) => line,
                            None => return Err(fewer_rows(lines.path())),
                        };
                        let (count, value) = parse_run_bytes(line)?;
                        self.run = (dictionary.id(value), count);
                    }
                    let take = need.min(self.run.1);
                    push_run(runs, self.run.0, take as u32);
                    self.run.1 -= take;
                    need -= take;
                }
            }
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<()> {
        match &mut self.lines {
            Lines::Missing => Ok(()),
            Lines::Plain(lines) | Lines::Runs(lines) => {
                if self.run.1 > 0 || lines.next_line()?.is_some() {
                    return Err(more_rows(lines.path()));
                }
                Ok(())
            }
        }
    }
}

fn expand(runs: &[(u32, u32)], ids: &mut Vec<u32>) {
    ids.clear();
    for (id, count) in runs {
        ids.extend(std::iter::repeat_n(*id, *count as usize));
    }
}

struct FilterState {
    column: usize,
    known: Vec<u8>,
}

const UNKNOWN: u8 = 0;

const KEEP: u8 = 1;

const DROP: u8 = 2;

impl FilterState {
    fn keeps(&mut self, filter: &Filter, dictionary: &ColumnDictionary, id: u32) -> bool {
        let at = id as usize;
        if at >= self.known.len() {
            self.known.resize(dictionary.len().max(at + 1), UNKNOWN);
        }
        if self.known[at] == UNKNOWN {
            let value = dictionary.text(id);
            self.known[at] = if filter.matches(value.as_deref()) {
                KEEP
            } else {
                DROP
            };
        }
        self.known[at] == KEEP
    }
}

struct Scan<'a> {
    query: &'a Query,
    columns: Vec<String>,
    dictionaries: Vec<ColumnDictionary>,
    filters: Vec<FilterState>,
    group_columns: Vec<usize>,
    visit_column: Option<usize>,
    keys: IdKeys,
    groups: Vec<Vec<u32>>,
    records: Vec<u64>,
    pairs: Vec<u64>,
    compact_at: usize,
    scanned: u64,
    matched: u64,
}

impl<'a> Scan<'a> {
    fn new(query: &'a Query, day: &str, wants_visits: bool) -> Scan<'a> {
        let parts = group_parts(&query.group_by, day);
        let mut columns: Vec<String> = Vec::new();
        let index_of = |field: &str, columns: &mut Vec<String>| match columns
            .iter()
            .position(|column| column == field)
        {
            Some(at) => at,
            None => {
                columns.push(field.to_string());
                columns.len() - 1
            }
        };
        let filter_columns: Vec<usize> = query
            .filters
            .iter()
            .map(|filter| index_of(&filter.field, &mut columns))
            .collect();
        let group_columns: Vec<usize> = parts
            .fields
            .iter()
            .map(|field| index_of(field, &mut columns))
            .collect();
        let named = columns.len();
        let visit_column = wants_visits.then(|| index_of("visit", &mut columns));
        let dictionaries = (0..columns.len())
            .map(|at| ColumnDictionary::new(at < named))
            .collect();
        Scan {
            query,
            columns,
            dictionaries,
            filters: filter_columns
                .into_iter()
                .map(|column| FilterState {
                    column,
                    known: Vec::new(),
                })
                .collect(),
            keys: IdKeys::new(group_columns.len(), u32::MAX as usize),
            group_columns,
            visit_column,
            groups: Vec::new(),
            records: Vec::new(),
            pairs: Vec::new(),
            compact_at: COMPACT_PAIRS,
            scanned: 0,
            matched: 0,
        }
    }

    fn part(&mut self, part: &Part, cancelled: &dyn Fn() -> bool) -> Result<()> {
        let mut readers = Vec::new();
        for column in &self.columns {
            readers.push(ColumnReader::open(part.column_file(column)?)?);
        }
        let mut runs: Vec<Vec<(u32, u32)>> = vec![Vec::new(); self.columns.len()];
        let mut ids: Vec<Vec<u32>> = vec![Vec::new(); self.columns.len()];
        let mut selected: Vec<bool> = Vec::with_capacity(BLOCK_ROWS);
        let mut key: Vec<u32> = Vec::with_capacity(self.group_columns.len());
        let mut last_pair = u64::MAX;
        let mut left = part.rows as usize;
        while left > 0 {
            if cancelled() {
                return Err(crate::query::cancelled_error());
            }
            let size = left.min(BLOCK_ROWS);
            for (at, reader) in readers.iter_mut().enumerate() {
                reader.read(size, &mut self.dictionaries[at], &mut runs[at])?;
            }
            selected.clear();
            selected.resize(size, true);
            for (index, filter) in self.filters.iter_mut().enumerate() {
                let dictionary = &self.dictionaries[filter.column];
                let mut row = 0;
                for (id, count) in &runs[filter.column] {
                    let end = row + *count as usize;
                    if !filter.keeps(&self.query.filters[index], dictionary, *id) {
                        selected[row..end].fill(false);
                    }
                    row = end;
                }
            }
            for at in self.group_columns.iter().copied().chain(self.visit_column) {
                expand(&runs[at], &mut ids[at]);
            }
            for (row, keep) in selected.iter().enumerate() {
                if !keep {
                    continue;
                }
                key.clear();
                key.extend(self.group_columns.iter().map(|at| ids[*at][row]));
                let target = match self.keys.get(&key) {
                    Some(target) => target,
                    None => {
                        let target = self.groups.len();
                        self.keys.insert(&key, target);
                        self.groups.push(key.clone());
                        self.records.push(0);
                        target
                    }
                };
                self.records[target] += 1;
                self.matched += 1;
                if let Some(at) = self.visit_column {
                    let visit = ids[at][row];
                    let pair = ((target as u64) << 32) | u64::from(visit);
                    if visit != NO_VALUE && pair != last_pair {
                        self.pairs.push(pair);
                        last_pair = pair;
                    }
                }
            }
            if self.pairs.len() >= self.compact_at {
                compact(&mut self.pairs);
                self.compact_at = COMPACT_PAIRS.max(self.pairs.len() * 2);
            }
            left -= size;
        }
        for reader in readers.iter_mut() {
            reader.finish()?;
        }
        self.scanned += part.rows;
        Ok(())
    }

    fn finish(mut self, day: &str) -> Draft {
        let parts = group_parts(&self.query.group_by, day);
        let mut visits = vec![0u64; self.groups.len()];
        compact(&mut self.pairs);
        for pair in &self.pairs {
            visits[(pair >> 32) as usize] += 1;
        }
        let groups = self
            .groups
            .iter()
            .enumerate()
            .map(|(target, key)| {
                let mut ids = key.iter().zip(&self.group_columns);
                let named: Vec<Option<String>> = parts
                    .time
                    .iter()
                    .map(|value| match value {
                        Some(value) => Some(value.clone()),
                        None => ids
                            .next()
                            .and_then(|(id, at)| self.dictionaries[*at].text(*id)),
                    })
                    .collect();
                (named, self.records[target], visits[target])
            })
            .collect();
        Draft {
            groups,
            scanned: self.scanned,
            matched: self.matched,
        }
    }
}

fn scan_once(
    path: &str,
    generations: &Generations,
    day: &str,
    query: &Query,
    wants_visits: bool,
    cancelled: &dyn Fn() -> bool,
) -> Result<Draft> {
    let mut scan = Scan::new(query, day, wants_visits);
    for part in read_day_parts(path, generations)? {
        scan.part(&part, cancelled)?;
    }
    Ok(scan.finish(day))
}

pub fn scan_day(
    path: &str,
    day: &str,
    query: &Query,
    wants_visits: bool,
    cancelled: &dyn Fn() -> bool,
) -> Result<Draft> {
    let mut attempt = 1;
    loop {
        let before = read_generations(path)?;
        let same = |after: &Generations| before.sealed == after.sealed && before.raws == after.raws;
        match scan_once(path, &before, day, query, wants_visits, cancelled) {
            Ok(draft) => {
                if same(&read_generations(path)?) {
                    return Ok(draft);
                }
            }
            Err(error) => {
                if error.status == Some(504) || !error.not_found || same(&read_generations(path)?) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn read_all(file: ColumnFile, rows: usize) -> Result<Vec<(u32, u32)>> {
        let mut reader = ColumnReader::open(file)?;
        let mut dictionary = ColumnDictionary::new(true);
        let mut runs = Vec::new();
        let mut all = Vec::new();
        let mut left = rows;
        while left > 0 {
            let size = left.min(2);
            reader.read(size, &mut dictionary, &mut runs)?;
            for (id, count) in &runs {
                push_run(&mut all, *id, *count);
            }
            left -= size;
        }
        reader.finish()?;
        Ok(all)
    }

    #[test]
    fn a_column_reads_as_runs_of_ids_and_checks_the_row_count() {
        let dir = TempDir::new();
        let plain = dir.join("plain.txt");
        std::fs::write(&plain, "a\na\n\nb\na\n").unwrap();
        let file = |max_bytes| ColumnFile::Plain {
            path: plain.clone(),
            max_bytes,
        };
        assert_eq!(
            read_all(file(None), 5).unwrap(),
            [(1, 2), (0, 1), (2, 1), (1, 1)]
        );
        assert_eq!(read_all(file(Some(4)), 2).unwrap(), [(1, 2)]);
        assert!(read_all(file(None), 4).is_err());
        assert!(read_all(file(None), 6).is_err());
        let runs = dir.join("runs.rle");
        std::fs::write(&runs, "3\tx\n2\t\n").unwrap();
        let file = || ColumnFile::Runs { path: runs.clone() };
        assert_eq!(read_all(file(), 5).unwrap(), [(1, 3), (0, 2)]);
        assert!(read_all(file(), 4).is_err());
        assert!(read_all(file(), 6).is_err());
        assert_eq!(read_all(ColumnFile::Missing, 3).unwrap(), [(0, 3)]);
    }
}
