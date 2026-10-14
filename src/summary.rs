use crate::error::{Error, Result};
use crate::json::{Object, Value};
use crate::names::{BASE_COLUMNS, MAX_SEGMENTS, is_reserved, is_segment_name};
use crate::records::{is_country, is_name, is_route_pattern, is_segment_value, is_type};
use crate::rle::Cell;
use std::collections::{BTreeSet, HashMap};

pub const SUMMARY_KINDS: [&str; 3] = ["counts", "tuples", "visits"];

pub fn summary_file(kind: &str) -> &'static str {
    match kind {
        "counts" => "summary-counts.tsv",
        "tuples" => "summary-tuples.tsv",
        "visits" => "summary-visits.tsv",
        _ => "summary-days.tsv",
    }
}

pub const PERIOD_DAYS_FILE: &str = "summary-days.tsv";

pub const COUNT_DIMENSIONS: [&str; 5] = ["type", "page", "zone", "name", "country"];

pub const VISIT_DIMENSIONS: [&str; 3] = ["type", "page", "country"];

pub const COUNT_MEASURES: [&str; 1] = ["records"];

#[derive(Default)]
struct Ordered<V> {
    index: HashMap<String, usize>,
    entries: Vec<(String, V)>,
}

impl<V: Default> Ordered<V> {
    fn entry(&mut self, key: &str) -> (usize, &mut V) {
        let at = match self.index.get(key) {
            Some(at) => *at,
            None => {
                let at = self.entries.len();
                self.index.insert(key.to_string(), at);
                self.entries.push((key.to_string(), V::default()));
                at
            }
        };
        (at, &mut self.entries[at].1)
    }
}

pub struct Files {
    pub counts: Vec<String>,
    pub tuples: Vec<String>,
    pub visits: Vec<String>,
}

impl Files {
    pub fn joined(&self) -> (String, String, String) {
        (
            self.counts.concat(),
            self.tuples.concat(),
            self.visits.concat(),
        )
    }
}

pub struct SummaryBuilder {
    count_dimensions: Vec<String>,
    visit_dimensions: Vec<String>,
    count_positions: Vec<Option<usize>>,
    visit_positions: Vec<Option<usize>>,
    visit_position: Option<usize>,
    counts: Ordered<u64>,
    tuples: Ordered<()>,
    visit_tuples: Ordered<BTreeSet<usize>>,
}

fn segments_of(columns: &[String]) -> Vec<String> {
    let mut segments: Vec<String> = columns
        .iter()
        .filter(|column| !BASE_COLUMNS.contains(&column.as_str()))
        .cloned()
        .collect();
    segments.sort();
    segments
}

fn key_of(columns: &[Vec<Cell>], row: usize, positions: &[Option<usize>]) -> String {
    let mut key = String::new();
    for (at, position) in positions.iter().enumerate() {
        if at > 0 {
            key.push('\t');
        }
        if let Some(position) = position
            && let Some(value) = &columns[*position][row]
        {
            key.push_str(value);
        }
    }
    key
}

impl SummaryBuilder {
    pub fn new(columns: &[String], row_columns: &[String]) -> Self {
        let segments = segments_of(columns);
        let count_dimensions: Vec<String> = COUNT_DIMENSIONS
            .iter()
            .map(|d| d.to_string())
            .chain(segments.iter().cloned())
            .collect();
        let visit_dimensions: Vec<String> = VISIT_DIMENSIONS
            .iter()
            .map(|d| d.to_string())
            .chain(segments.iter().cloned())
            .collect();
        let position = |name: &str| row_columns.iter().position(|column| column == name);
        SummaryBuilder {
            count_positions: count_dimensions.iter().map(|d| position(d)).collect(),
            visit_positions: visit_dimensions.iter().map(|d| position(d)).collect(),
            visit_position: position("visit"),
            count_dimensions,
            visit_dimensions,
            counts: Ordered::default(),
            tuples: Ordered::default(),
            visit_tuples: Ordered::default(),
        }
    }

    pub fn add_rows(&mut self, columns: &[Vec<Cell>], count: usize) {
        for row in 0..count {
            let count_key = key_of(columns, row, &self.count_positions);
            *self.counts.entry(&count_key).1 += 1;
            let tuple_key = key_of(columns, row, &self.visit_positions);
            let (index, _) = self.tuples.entry(&tuple_key);
            let Some(position) = self.visit_position else {
                continue;
            };
            let Some(visit) = &columns[position][row] else {
                continue;
            };
            self.visit_tuples.entry(visit).1.insert(index);
        }
    }

    pub fn finish(self) -> Files {
        let mut counts = vec![format!(
            "{}\t{}\n",
            self.count_dimensions.join("\t"),
            COUNT_MEASURES.join("\t")
        )];
        for (key, records) in &self.counts.entries {
            counts.push(format!("{key}\t{records}\n"));
        }
        let mut tuples = vec![format!("{}\n", self.visit_dimensions.join("\t"))];
        for (key, _) in &self.tuples.entries {
            tuples.push(format!("{key}\n"));
        }
        let mut visit_counts: Ordered<u64> = Ordered::default();
        for (_, set) in &self.visit_tuples.entries {
            let key = set
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(",");
            *visit_counts.entry(&key).1 += 1;
        }
        let mut visits = vec!["visits\ttuples\n".to_string()];
        for (key, count) in &visit_counts.entries {
            visits.push(format!("{count}\t{key}\n"));
        }
        Files {
            counts,
            tuples,
            visits,
        }
    }
}

pub struct Table<'a> {
    pub header: Vec<&'a str>,
    pub lines: Vec<&'a str>,
}

pub fn table_lines(text: &str) -> Result<Table<'_>> {
    let Some(body) = text.strip_suffix('\n') else {
        return Err(Error::new("a summary file does not end with a line break"));
    };
    let mut lines = body.split('\n');
    let header = lines.next().unwrap_or("").split('\t').collect();
    Ok(Table {
        header,
        lines: lines.collect(),
    })
}

fn canonical_key(header: &[&str], cells: &[&str], base: usize) -> String {
    let mut key = cells[..base.min(cells.len())].join("\t");
    for (index, name) in header.iter().enumerate().skip(base) {
        let cell = cells.get(index).copied().unwrap_or("");
        if !cell.is_empty() {
            key.push('\t');
            key.push_str(name);
            key.push('=');
            key.push_str(cell);
        }
    }
    key
}

fn expand_key(key: &str, base: usize, segments: &[String]) -> String {
    let parts: Vec<&str> = key.split('\t').collect();
    let mut values: HashMap<&str, &str> = HashMap::new();
    for part in parts.iter().skip(base) {
        if let Some((name, value)) = part.split_once('=') {
            values.insert(name, value);
        }
    }
    let mut out: Vec<&str> = parts.iter().take(base).copied().collect();
    for segment in segments {
        out.push(values.get(segment.as_str()).copied().unwrap_or(""));
    }
    out.join("\t")
}

#[derive(Default)]
pub struct SummaryMerger {
    segments: BTreeSet<String>,
    counts: Ordered<u64>,
    tuples: Ordered<()>,
    visits: Ordered<u64>,
    rows: u64,
}

pub struct SummaryText<'a> {
    pub counts: &'a str,
    pub tuples: &'a str,
    pub visits: &'a str,
}

impl SummaryMerger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, summary: &SummaryText) -> Result<()> {
        let count_table = table_lines(summary.counts)?;
        let count_header = &count_table.header[..count_table
            .header
            .len()
            .saturating_sub(COUNT_MEASURES.len())];
        for segment in count_header.iter().skip(COUNT_DIMENSIONS.len()) {
            self.segments.insert(segment.to_string());
        }
        for line in &count_table.lines {
            let cells: Vec<&str> = line.split('\t').collect();
            let key = canonical_key(count_header, &cells, COUNT_DIMENSIONS.len());
            let records: u64 = cells
                .get(count_header.len())
                .and_then(|cell| cell.parse().ok())
                .unwrap_or(0);
            *self.counts.entry(&key).1 += records;
            self.rows += records;
        }
        let tuple_table = table_lines(summary.tuples)?;
        for segment in tuple_table.header.iter().skip(VISIT_DIMENSIONS.len()) {
            self.segments.insert(segment.to_string());
        }
        let indexes: Vec<usize> = tuple_table
            .lines
            .iter()
            .map(|line| {
                let cells: Vec<&str> = line.split('\t').collect();
                let key = canonical_key(&tuple_table.header, &cells, VISIT_DIMENSIONS.len());
                self.tuples.entry(&key).0
            })
            .collect();
        let visits = &mut self.visits;
        for_each_visit_line(summary.visits, |count, local| {
            let mut set: Vec<usize> = local
                .iter()
                .map(|index| indexes.get(*index).copied().unwrap_or(usize::MAX))
                .collect();
            set.sort_unstable();
            set.dedup();
            let key = set
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(",");
            *visits.entry(&key).1 += count;
        })?;
        Ok(())
    }

    pub fn finish(self) -> (u64, Files) {
        let sorted: Vec<String> = self.segments.into_iter().collect();
        let header: Vec<String> = COUNT_DIMENSIONS
            .iter()
            .map(|d| d.to_string())
            .chain(sorted.iter().cloned())
            .chain(COUNT_MEASURES.iter().map(|m| m.to_string()))
            .collect();
        let mut counts = vec![format!("{}\n", header.join("\t"))];
        for (key, records) in &self.counts.entries {
            counts.push(format!(
                "{}\t{records}\n",
                expand_key(key, COUNT_DIMENSIONS.len(), &sorted)
            ));
        }
        let tuple_header: Vec<String> = VISIT_DIMENSIONS
            .iter()
            .map(|d| d.to_string())
            .chain(sorted.iter().cloned())
            .collect();
        let mut tuples = vec![format!("{}\n", tuple_header.join("\t"))];
        for (key, _) in &self.tuples.entries {
            tuples.push(format!(
                "{}\n",
                expand_key(key, VISIT_DIMENSIONS.len(), &sorted)
            ));
        }
        let mut visits = vec!["visits\ttuples\n".to_string()];
        for (key, count) in &self.visits.entries {
            visits.push(format!("{count}\t{key}\n"));
        }
        (
            self.rows,
            Files {
                counts,
                tuples,
                visits,
            },
        )
    }
}

pub fn format_period_days(days: &[(String, u64)]) -> String {
    let mut sorted = days.to_vec();
    sorted.sort();
    let mut out = "day\trecords\n".to_string();
    for (day, rows) in sorted {
        out.push_str(&format!("{day}\t{rows}\n"));
    }
    out
}

fn is_positive(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 16
        && text.as_bytes()[0] != b'0'
        && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn has_control_character(text: &str) -> bool {
    text.chars()
        .any(|c| (c < ' ' && c != '\t' && c != '\n') || c == '\u{7f}')
}

pub fn parse_period_days(text: &str, allowed: &[String]) -> Result<(Vec<(String, u64)>, u64)> {
    if has_control_character(text) {
        return Err(Error::new(format!(
            "{PERIOD_DAYS_FILE} holds a control character"
        )));
    }
    let table = table_lines(text)?;
    if table.header != ["day", "records"] {
        return Err(Error::new(format!(
            "{PERIOD_DAYS_FILE} has a header that is not valid"
        )));
    }
    if table.lines.is_empty() {
        return Err(Error::new(format!("{PERIOD_DAYS_FILE} lists no day")));
    }
    let mut days = Vec::new();
    let mut rows = 0u64;
    let mut previous = String::new();
    for line in &table.lines {
        let cells: Vec<&str> = line.split('\t').collect();
        if cells.len() != 2
            || !allowed.iter().any(|day| day == cells[0])
            || cells[0] <= previous.as_str()
            || !is_positive(cells[1])
        {
            return Err(Error::new(format!(
                "{PERIOD_DAYS_FILE} has a line that is not valid"
            )));
        }
        previous = cells[0].to_string();
        let count: u64 = cells[1].parse().unwrap_or(0);
        days.push((cells[0].to_string(), count));
        rows = rows.saturating_add(count);
    }
    if rows > 9_007_199_254_740_991 {
        return Err(Error::new(format!(
            "{PERIOD_DAYS_FILE} counts too many records"
        )));
    }
    Ok((days, rows))
}

pub fn for_each_visit_line(text: &str, mut on_line: impl FnMut(u64, &[usize])) -> Result<()> {
    let bytes = text.as_bytes();
    let invalid = || Error::new("a summary visit line is not valid");
    let mut position = match bytes.iter().position(|byte| *byte == b'\n') {
        Some(at) => at + 1,
        None => return Ok(()),
    };
    let mut tuples = Vec::new();
    while position < bytes.len() {
        let mut visits = 0u64;
        loop {
            let byte = *bytes.get(position).ok_or_else(invalid)?;
            if byte == b'\t' {
                break;
            }
            if !byte.is_ascii_digit() {
                return Err(invalid());
            }
            visits = visits
                .checked_mul(10)
                .and_then(|value| value.checked_add(u64::from(byte - b'0')))
                .ok_or_else(invalid)?;
            position += 1;
        }
        tuples.clear();
        let mut index = 0usize;
        position += 1;
        loop {
            let byte = *bytes.get(position).ok_or_else(invalid)?;
            if byte == b',' || byte == b'\n' {
                tuples.push(index);
                index = 0;
                if byte == b'\n' {
                    break;
                }
            } else if byte.is_ascii_digit() {
                index = index
                    .checked_mul(10)
                    .and_then(|value| value.checked_add(usize::from(byte - b'0')))
                    .ok_or_else(invalid)?;
            } else {
                return Err(invalid());
            }
            position += 1;
        }
        on_line(visits, &tuples);
        position += 1;
    }
    Ok(())
}

fn optional(check: fn(&str) -> bool, value: &str) -> bool {
    value.is_empty() || check(value)
}

fn valid_cell(dimension: &str, value: &str) -> bool {
    match dimension {
        "type" => is_type(value),
        "page" => is_route_pattern(value),
        "zone" | "name" => optional(is_name, value),
        "country" => optional(is_country, value),
        _ => optional(is_segment_value, value),
    }
}

fn valid_cells(dimensions: &[String], cells: &[&str]) -> bool {
    cells.len() >= dimensions.len()
        && dimensions
            .iter()
            .zip(cells)
            .all(|(dimension, cell)| valid_cell(dimension, cell))
}

fn check_segments(segments: &[&str]) -> Result<()> {
    if segments.len() > MAX_SEGMENTS {
        return Err(Error::new("the summary has too many segments"));
    }
    for (index, segment) in segments.iter().enumerate() {
        if !is_segment_name(segment) || is_reserved(segment) {
            return Err(Error::new(format!(
                "the summary has a segment \"{segment}\" that is not valid"
            )));
        }
        if index > 0 && segments[index - 1] >= *segment {
            return Err(Error::new("the summary segments are not sorted"));
        }
    }
    Ok(())
}

fn is_visit_line(line: &str) -> bool {
    let Some((visits, tuples)) = line.split_once('\t') else {
        return false;
    };
    is_positive(visits)
        && tuples.split(',').all(|index| {
            !index.is_empty()
                && index.len() <= 15
                && index.bytes().all(|byte| byte.is_ascii_digit())
        })
}

pub fn check_summary(counts: &str, tuples: &str, visits: &str) -> Result<u64> {
    for text in [counts, tuples, visits] {
        if has_control_character(text) {
            return Err(Error::new("a summary file holds a control character"));
        }
    }
    let count_table = table_lines(counts)?;
    let header_length = count_table.header.len();
    if header_length < COUNT_DIMENSIONS.len() + COUNT_MEASURES.len() {
        return Err(Error::new(format!(
            "{} has a header that is not valid",
            summary_file("counts")
        )));
    }
    let segments: Vec<&str> =
        count_table.header[COUNT_DIMENSIONS.len()..header_length - COUNT_MEASURES.len()].to_vec();
    check_segments(&segments)?;
    let count_dimensions: Vec<String> = COUNT_DIMENSIONS
        .iter()
        .copied()
        .chain(segments.iter().copied())
        .map(str::to_string)
        .collect();
    let mut count_header = count_dimensions.clone();
    count_header.extend(COUNT_MEASURES.iter().map(|m| m.to_string()));
    if count_table.header != count_header {
        return Err(Error::new(format!(
            "{} has a header that is not valid",
            summary_file("counts")
        )));
    }
    let mut rows = 0u64;
    for line in &count_table.lines {
        let cells: Vec<&str> = line.split('\t').collect();
        let records = cells.get(count_dimensions.len()).copied().unwrap_or("");
        if cells.len() != count_header.len()
            || !valid_cells(&count_dimensions, &cells)
            || !is_positive(records)
        {
            return Err(Error::new(format!(
                "{} has a line that is not valid",
                summary_file("counts")
            )));
        }
        rows = rows.saturating_add(records.parse::<u64>().unwrap_or(0));
    }
    if rows > 9_007_199_254_740_991 {
        return Err(Error::new(format!(
            "{} counts too many records",
            summary_file("counts")
        )));
    }
    let tuple_table = table_lines(tuples)?;
    let tuple_header: Vec<String> = VISIT_DIMENSIONS
        .iter()
        .copied()
        .chain(segments.iter().copied())
        .map(str::to_string)
        .collect();
    if tuple_table.header != tuple_header {
        return Err(Error::new(format!(
            "{} has a header that is not valid",
            summary_file("tuples")
        )));
    }
    for line in &tuple_table.lines {
        let cells: Vec<&str> = line.split('\t').collect();
        if cells.len() != tuple_header.len() || !valid_cells(&tuple_header, &cells) {
            return Err(Error::new(format!(
                "{} has a line that is not valid",
                summary_file("tuples")
            )));
        }
    }
    let visit_table = table_lines(visits)?;
    if visit_table.header != ["visits", "tuples"] {
        return Err(Error::new(format!(
            "{} has a header that is not valid",
            summary_file("visits")
        )));
    }
    for line in &visit_table.lines {
        let valid = is_visit_line(line)
            && line
                .split_once('\t')
                .map(|(_, list)| list)
                .unwrap_or("")
                .split(',')
                .all(|index| {
                    index
                        .parse::<usize>()
                        .is_ok_and(|at| at < tuple_table.lines.len())
                });
        if !valid {
            return Err(Error::new(format!(
                "{} has a line that is not valid",
                summary_file("visits")
            )));
        }
    }
    Ok(rows)
}

pub fn period_days_value(days: &[(String, u64, u64)]) -> Value {
    let mut object = Object::new();
    for (day, rows, wal) in days {
        object.insert(
            day.clone(),
            Object::new().with("rows", *rows).with("wal", *wal),
        );
    }
    object.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(count: &str, tuple: &str, records: &str) -> (String, String, String) {
        (
            format!("type\tpage\tzone\tname\tcountry\tplan\trecords\n{count}\t{records}\n"),
            format!("type\tpage\tcountry\tplan\n{tuple}\n"),
            "visits\ttuples\n1\t0\n".to_string(),
        )
    }

    fn check(parts: (String, String, String)) -> Result<u64> {
        check_summary(&parts.0, &parts.1, &parts.2)
    }

    #[test]
    fn a_summary_with_a_value_that_a_record_cannot_have_fails_the_check() {
        let good = "seen\t/\tmyapp.send\t\tPL\tpro";
        assert_eq!(check(summary(good, "seen\t/\tPL\tpro", "1")).unwrap(), 1);
        let counts = [
            "click\t/\t\t\t\t".to_string(),
            "seen\t\t\t\t\t".to_string(),
            "seen\t/\t<b>.x\t\t\t".to_string(),
            "outcome\t/\t\tsent\t\t".to_string(),
            "seen\t/\t\t\tpl\t".to_string(),
            "seen\t/\t\t\t\t<script>".to_string(),
            "seen\tinvoices\t\t\t\t".to_string(),
            format!("seen\t/{}\t\t\t\t", "x".repeat(512)),
        ];
        for count in counts {
            let error = check(summary(&count, "seen\t/\tPL\tpro", "1")).unwrap_err();
            assert!(error.message.contains("line that is not valid"), "{count}");
        }
        assert!(check(summary(good, "seen\t/\tPL\ta b", "1")).is_err());
        assert!(check(summary(good, "seen\tno-slash\tPL\tpro", "1")).is_err());
        assert_eq!(
            check(summary(
                "seen\t/invoices/:id\t\t\t\t",
                "seen\t/\tPL\tpro",
                "1"
            ))
            .unwrap(),
            1
        );
        let page = "page\t/\t\t\tPL\tpro";
        assert_eq!(check(summary(page, "page\t/\tPL\tpro", "2")).unwrap(), 2);
        for records in ["0", "-1", "1.5", "01", "", "2\t420"] {
            assert!(
                check(summary(page, "page\t/\tPL\tpro", records)).is_err(),
                "{records}"
            );
        }
    }

    #[test]
    fn the_merge_of_daily_summaries_adds_the_counts_and_keeps_each_visit_of_a_day() {
        let first = SummaryText {
            counts: "type\tpage\tzone\tname\tcountry\trecords\npage\t/\t\t\tPL\t2\n",
            tuples: "type\tpage\tcountry\npage\t/\tPL\n",
            visits: "visits\ttuples\n2\t0\n",
        };
        let second = SummaryText {
            counts: "type\tpage\tzone\tname\tcountry\tplan\trecords\npage\t/\t\t\tPL\tpro\t1\npage\t/\t\t\tPL\t\t1\n",
            tuples: "type\tpage\tcountry\tplan\npage\t/\tPL\tpro\npage\t/\tPL\t\n",
            visits: "visits\ttuples\n1\t0,1\n",
        };
        let mut merger = SummaryMerger::new();
        merger.add(&first).unwrap();
        merger.add(&second).unwrap();
        let (rows, files) = merger.finish();
        assert_eq!(rows, 4);
        let (counts, tuples, visits) = files.joined();
        assert_eq!(
            counts,
            "type\tpage\tzone\tname\tcountry\tplan\trecords\npage\t/\t\t\tPL\t\t3\npage\t/\t\t\tPL\tpro\t1\n"
        );
        assert_eq!(
            tuples,
            "type\tpage\tcountry\tplan\npage\t/\tPL\t\npage\t/\tPL\tpro\n"
        );
        assert_eq!(visits, "visits\ttuples\n2\t0\n1\t0,1\n");
        assert_eq!(check_summary(&counts, &tuples, &visits).unwrap(), 4);
    }

    #[test]
    fn a_visit_line_without_a_tab_fails_and_does_not_loop() {
        assert!(for_each_visit_line("visits\ttuples\n12\n", |_, _| {}).is_err());
        assert!(for_each_visit_line("visits\ttuples\n12", |_, _| {}).is_err());
        let mut seen = Vec::new();
        for_each_visit_line("visits\ttuples\n3\t0,2\n1\t1\n", |count, tuples| {
            seen.push((count, tuples.to_vec()));
        })
        .unwrap();
        assert_eq!(seen, [(3, vec![0, 2]), (1, vec![1])]);
    }
}
