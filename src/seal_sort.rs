use crate::column_store::Part;
use crate::error::{Error, Result};
use crate::fsutil::remove_if_exists;
use crate::line_files::{LineReader, LineWriter, ValueReader, ValueSource};
use crate::paths::join;
use crate::rle::{Cell, parse_run};
use std::cmp::Ordering;
use std::collections::HashMap;

pub const SEAL_CHUNK_ROWS: usize = 250_000;

pub const MAX_SORT_RUNS: u64 = 64;

const MERGE_BLOCK_ROWS: usize = 4_096;

fn compare_text(a: &Cell, b: &Cell) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(a), Some(b)) => a.as_ref().cmp(b.as_ref()),
    }
}

fn number_of(cell: &Cell) -> f64 {
    match cell {
        None => f64::NEG_INFINITY,
        Some(text) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
    }
}

fn ranks_of(values: &[Cell]) -> Vec<u32> {
    let mut unique: Vec<&Cell> = values.iter().collect();
    unique.sort_by(|a, b| compare_text(a, b));
    unique.dedup_by(|a, b| compare_text(a, b) == Ordering::Equal);
    let rank_of: HashMap<Option<&str>, u32> = unique
        .iter()
        .enumerate()
        .map(|(rank, value)| (value.as_deref(), rank as u32))
        .collect();
    values
        .iter()
        .map(|value| rank_of[&value.as_deref()])
        .collect()
}

fn compare_numbers(a: f64, b: f64) -> Ordering {
    let difference = a - b;
    if difference.is_nan() || difference == 0.0 {
        Ordering::Equal
    } else if difference < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

fn sort_chunk(
    columns: &[Vec<Cell>],
    count: usize,
    text_keys: &[usize],
    number_key: usize,
) -> Vec<u32> {
    let ranks: Vec<Vec<u32>> = text_keys
        .iter()
        .map(|key| ranks_of(&columns[*key]))
        .collect();
    let numbers: Vec<f64> = columns[number_key].iter().map(number_of).collect();
    let mut order: Vec<u32> = (0..count as u32).collect();
    order.sort_by(|a, b| {
        let (a, b) = (*a as usize, *b as usize);
        for rank in &ranks {
            match rank[a].cmp(&rank[b]) {
                Ordering::Equal => continue,
                other => return other,
            }
        }
        compare_numbers(numbers[a], numbers[b]).then(a.cmp(&b))
    });
    order
}

fn run_path(dir: &str, run: usize, column: usize) -> String {
    join(&[dir, &format!("sort-{run}-{column}.txt")])
}

fn write_run(dir: &str, run: usize, columns: &[Vec<Cell>], order: &[u32]) -> Result<()> {
    for (column, values) in columns.iter().enumerate() {
        let mut writer = LineWriter::create(&run_path(dir, run, column))?;
        let mut text = String::new();
        for position in order {
            if let Some(value) = &values[*position as usize] {
                text.push_str(value);
            }
            text.push('\n');
            if text.len() >= 1 << 20 {
                writer.write(&text)?;
                text.clear();
            }
        }
        writer.write(&text)?;
        writer.close()?;
    }
    Ok(())
}

struct Source {
    index: usize,
    columns: Vec<Vec<Cell>>,
    order: Option<Vec<u32>>,
    position: usize,
    size: usize,
    readers: Vec<ValueReader>,
    left: u64,
}

impl Source {
    fn row(&self) -> Option<usize> {
        if self.position >= self.size {
            return None;
        }
        Some(match &self.order {
            Some(order) => order[self.position] as usize,
            None => self.position,
        })
    }

    fn cell(&self, column: usize) -> &Cell {
        let row = self.row().unwrap_or(0);
        &self.columns[column][row]
    }

    fn fill(&mut self) -> Result<()> {
        let size = (MERGE_BLOCK_ROWS as u64).min(self.left) as usize;
        self.left -= size as u64;
        let mut columns = Vec::with_capacity(self.readers.len());
        for reader in &mut self.readers {
            columns.push(if size > 0 {
                reader.take(size)?
            } else {
                Vec::new()
            });
        }
        self.columns = columns;
        self.size = size;
        self.position = 0;
        Ok(())
    }

    fn advance(&mut self) -> Result<()> {
        self.position += 1;
        if self.position >= self.size && self.order.is_none() && self.left > 0 {
            self.fill()?;
        }
        Ok(())
    }
}

fn source_before(a: &Source, b: &Source, text_keys: &[usize], number_key: usize) -> bool {
    for key in text_keys {
        let left = a.cell(*key);
        let right = b.cell(*key);
        if left != right {
            return compare_text(left, right) == Ordering::Less;
        }
    }
    let left = a.cell(number_key);
    let right = b.cell(number_key);
    if left != right {
        if left.is_none() {
            return true;
        }
        if right.is_none() {
            return false;
        }
        return number_of(left) < number_of(right);
    }
    a.index < b.index
}

struct Heap {
    items: Vec<usize>,
}

impl Heap {
    fn down(&mut self, start: usize, before: &dyn Fn(usize, usize) -> bool) {
        let mut index = start;
        loop {
            let left = index * 2 + 1;
            let right = left + 1;
            let mut first = index;
            if left < self.items.len() && before(self.items[left], self.items[first]) {
                first = left;
            }
            if right < self.items.len() && before(self.items[right], self.items[first]) {
                first = right;
            }
            if first == index {
                return;
            }
            self.items.swap(index, first);
            index = first;
        }
    }
}

fn to_plain(dir: &str, column: &str) -> Result<()> {
    let path = join(&[dir, &format!("{column}.rle")]);
    let mut reader = LineReader::open(&path, None)?;
    let mut writer = LineWriter::create(&join(&[dir, &format!("{column}.txt")]))?;
    let mut text = String::new();
    while let Some(block) = reader.read_block()? {
        for line in block {
            let (count, value) = parse_run(&line)?;
            for _ in 0..count {
                text.push_str(value);
                text.push('\n');
            }
            if text.len() >= 1 << 20 {
                writer.write(&text)?;
                text.clear();
            }
        }
    }
    writer.write(&text)?;
    writer.close()?;
    remove_if_exists(&path)?;
    Ok(())
}

struct Output {
    position: usize,
    value: Cell,
    count: u64,
    runs: u64,
    writer: LineWriter,
    text: String,
}

impl Output {
    fn emit(&mut self) -> Result<()> {
        if self.count > 0 {
            self.text.push_str(&self.count.to_string());
            self.text.push('\t');
            if let Some(value) = &self.value {
                self.text.push_str(value);
            }
            self.text.push('\n');
            if self.text.len() >= 1 << 20 {
                self.writer.write(&self.text)?;
                self.text.clear();
            }
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub fn sort_day(
    parts: &[Part],
    rows: u64,
    row_columns: &[String],
    columns: &[String],
    sort_columns: &[&str],
    number_column: &str,
    dir: &str,
    chunk_rows: usize,
    on_rows: &mut dyn FnMut(&[Vec<Cell>], usize),
) -> Result<Vec<String>> {
    let position_of = |name: &str| row_columns.iter().position(|column| column == name);
    let text_keys: Vec<usize> = sort_columns
        .iter()
        .filter_map(|column| position_of(column))
        .collect();
    let number_key = position_of(number_column)
        .ok_or_else(|| Error::new(format!("the sort needs the column {number_column}")))?;
    let chunk_size = (chunk_rows as u64).max(rows.div_ceil(MAX_SORT_RUNS)).max(1) as usize;
    let mut runs: Vec<u64> = Vec::new();
    let result = (|| -> Result<Vec<String>> {
        let mut last: (Vec<Vec<Cell>>, Vec<u32>) =
            (row_columns.iter().map(|_| Vec::new()).collect(), Vec::new());
        let mut read = 0u64;
        for part in parts {
            let mut readers = Vec::new();
            for column in row_columns {
                readers.push(part.open(column)?);
            }
            let mut start = 0u64;
            while start < part.rows {
                let count = (chunk_size as u64).min(part.rows - start) as usize;
                let mut chunk = Vec::with_capacity(readers.len());
                for reader in &mut readers {
                    chunk.push(reader.take(count)?);
                }
                on_rows(&chunk, count);
                let order = sort_chunk(&chunk, count, &text_keys, number_key);
                read += count as u64;
                if read < rows {
                    write_run(dir, runs.len(), &chunk, &order)?;
                    runs.push(count as u64);
                } else {
                    last = (chunk, order);
                }
                start += count as u64;
            }
            for reader in &mut readers {
                reader.finish()?;
            }
        }
        if read != rows {
            return Err(Error::new(format!(
                "the day holds {read} rows, expected {rows}"
            )));
        }
        let mut sources: Vec<Source> = Vec::new();
        for (run, count) in runs.iter().enumerate() {
            let mut readers = Vec::new();
            for column in 0..row_columns.len() {
                readers.push(ValueReader::open(&run_path(dir, run, column), None)?);
            }
            let mut source = Source {
                index: run,
                columns: Vec::new(),
                order: None,
                position: 0,
                size: 0,
                readers,
                left: *count,
            };
            source.fill()?;
            sources.push(source);
        }
        let (last_columns, last_order) = last;
        sources.push(Source {
            index: runs.len(),
            size: last_order.len(),
            columns: last_columns,
            order: Some(last_order),
            position: 0,
            readers: Vec::new(),
            left: 0,
        });
        let mut outputs = Vec::new();
        for column in columns {
            outputs.push(Output {
                position: position_of(column).unwrap_or(0),
                value: None,
                count: 0,
                runs: 0,
                writer: LineWriter::create(&join(&[dir, &format!("{column}.rle")]))?,
                text: String::new(),
            });
        }
        let mut heap = Heap {
            items: (0..sources.len())
                .filter(|index| sources[*index].row().is_some())
                .collect(),
        };
        {
            let before = |a: usize, b: usize| {
                source_before(&sources[a], &sources[b], &text_keys, number_key)
            };
            for index in (0..heap.items.len() / 2).rev() {
                heap.down(index, &before);
            }
        }
        while let Some(top) = heap.items.first().copied() {
            let source = &sources[top];
            for output in &mut outputs {
                let value = source.cell(output.position);
                if output.count > 0 && *value == output.value {
                    output.count += 1;
                    continue;
                }
                output.emit()?;
                output.value = value.clone();
                output.count = 1;
                output.runs += 1;
            }
            sources[top].advance()?;
            if sources[top].row().is_none() {
                let last = heap.items.pop().unwrap_or(top);
                if !heap.items.is_empty() {
                    heap.items[0] = last;
                    let before = |a: usize, b: usize| {
                        source_before(&sources[a], &sources[b], &text_keys, number_key)
                    };
                    heap.down(0, &before);
                }
            } else {
                let before = |a: usize, b: usize| {
                    source_before(&sources[a], &sources[b], &text_keys, number_key)
                };
                heap.down(0, &before);
            }
        }
        let mut plain = Vec::new();
        let mut finished = Vec::new();
        for (column, mut output) in columns.iter().zip(outputs) {
            output.emit()?;
            output.writer.write(&output.text)?;
            output.writer.close()?;
            finished.push((column, output.runs));
        }
        for (column, count) in finished {
            if count * 2 > rows {
                plain.push(column.clone());
                to_plain(dir, column)?;
            }
        }
        Ok(plain)
    })();
    for run in 0..runs.len() {
        for column in 0..row_columns.len() {
            let _ = remove_if_exists(&run_path(dir, run, column));
        }
    }
    result
}
