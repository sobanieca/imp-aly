use crate::column_store::{
    DaySummary, accept_all, list_days, list_sources, read_day, read_day_summary, source_dir,
};
use crate::days::{PERIOD_KINDS, PeriodKind, month_of, period_days};
use crate::error::{Error, Result};
use crate::json::{Object, Value};
use crate::periods::{list_period_sources, list_periods, read_period_days, read_period_summary};
use crate::query_core::{
    Aggregate, MAX_GROUPS, Parts, Query, can_use_summary, group_parts, query_error, time_field_of,
};
use crate::rle::Cell;
use crate::summary::{COUNT_MEASURES, for_each_visit_line, table_lines};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

pub type Cancelled<'a> = &'a dyn Fn() -> bool;

const CHECK_EVERY_ROWS: usize = 65_536;

pub fn cancelled_error() -> Error {
    Error::status(504, "the query was stopped")
}

struct DayResult {
    scanned: u64,
    matched: u64,
}

fn scan_day(
    path: &str,
    day: &str,
    query: &Query,
    aggregate: &mut Aggregate,
    wants_visits: bool,
    cancelled: Cancelled,
) -> Result<DayResult> {
    let parts = group_parts(&query.group_by, day);
    let mut columns: Vec<String> = Vec::new();
    for field in query
        .filters
        .iter()
        .map(|filter| &filter.field)
        .chain(parts.fields.iter())
    {
        if !columns.contains(field) {
            columns.push(field.clone());
        }
    }
    if wants_visits && !columns.iter().any(|column| column == "visit") {
        columns.push("visit".to_string());
    }
    let data = read_day(path, &columns)?;
    let rows = data.rows as usize;
    let mut selected = vec![true; rows];
    for filter in &query.filters {
        let column = data.column(&filter.field);
        for (row, keep) in selected.iter_mut().enumerate() {
            if *keep && !filter.matches(column.get(row).and_then(|cell| cell.as_deref())) {
                *keep = false;
            }
        }
    }
    let group_columns: Vec<Option<&[Cell]>> = query
        .group_by
        .iter()
        .enumerate()
        .map(|(index, field)| match parts.time[index] {
            Some(_) => None,
            None => Some(data.column(field)),
        })
        .collect();
    let visit_column = data.column("visit");
    let mut day_visits: HashMap<usize, HashSet<Arc<str>>> = HashMap::new();
    let mut matched = 0u64;
    for (row, keep) in selected.iter().enumerate() {
        if row % CHECK_EVERY_ROWS == 0 && cancelled() {
            return Err(cancelled_error());
        }
        if !keep {
            continue;
        }
        matched += 1;
        let group: Parts = group_columns
            .iter()
            .enumerate()
            .map(|(index, column)| match column {
                None => parts.time[index].clone(),
                Some(values) => values
                    .get(row)
                    .cloned()
                    .flatten()
                    .map(|value| value.to_string()),
            })
            .collect();
        let target = aggregate.group(group);
        aggregate.groups[target].records += 1;
        if wants_visits && let Some(Some(visit)) = visit_column.get(row) {
            day_visits.entry(target).or_default().insert(visit.clone());
        }
    }
    for (target, visits) in day_visits {
        aggregate.groups[target].visits += visits.len() as u64;
    }
    Ok(DayResult {
        scanned: rows as u64,
        matched,
    })
}

fn summary_day(
    summary: &DaySummary,
    day: &str,
    query: &Query,
    aggregate: &mut Aggregate,
    wants_visits: bool,
) -> Result<DayResult> {
    let parts = group_parts(&query.group_by, day);
    let needed: Vec<&str> = query
        .filters
        .iter()
        .map(|filter| filter.field.as_str())
        .chain(parts.fields.iter().map(String::as_str))
        .collect();
    let positions_of = |header: &[&str]| -> Vec<Option<usize>> {
        needed
            .iter()
            .map(|field| header.iter().position(|name| name == field))
            .collect()
    };
    let select =
        |cells: &[&str], positions: &[Option<usize>], aggregate: &mut Aggregate| -> Option<usize> {
            let values: Vec<Option<&str>> = positions
                .iter()
                .map(|position| {
                    position
                        .and_then(|at| cells.get(at).copied())
                        .filter(|cell| !cell.is_empty())
                })
                .collect();
            for (index, filter) in query.filters.iter().enumerate() {
                if !filter.matches(values[index]) {
                    return None;
                }
            }
            let mut next = query.filters.len();
            let group: Parts = parts
                .time
                .iter()
                .map(|value| match value {
                    Some(value) => Some(value.clone()),
                    None => {
                        let cell = values.get(next).copied().flatten().map(str::to_string);
                        next += 1;
                        cell
                    }
                })
                .collect();
            Some(aggregate.group(group))
        };
    let counts = table_lines(&summary.counts)?;
    let count_positions = positions_of(&counts.header);
    let records_at = counts.header.len().saturating_sub(COUNT_MEASURES.len());
    let mut matched = 0u64;
    for line in &counts.lines {
        let cells: Vec<&str> = line.split('\t').collect();
        let Some(target) = select(&cells, &count_positions, aggregate) else {
            continue;
        };
        let records: u64 = cells
            .get(records_at)
            .and_then(|cell| cell.parse().ok())
            .unwrap_or(0);
        matched += records;
        aggregate.groups[target].records += records;
    }
    if wants_visits {
        let tuples = table_lines(summary.tuples.as_deref().unwrap_or(""))?;
        let tuple_positions = positions_of(&tuples.header);
        let targets: Vec<Option<usize>> = tuples
            .lines
            .iter()
            .map(|line| {
                let cells: Vec<&str> = line.split('\t').collect();
                select(&cells, &tuple_positions, aggregate)
            })
            .collect();
        for_each_visit_line(
            summary.visits.as_deref().unwrap_or(""),
            |visits, indexes| {
                aggregate.stamp += 1;
                let stamp = aggregate.stamp;
                for index in indexes {
                    let Some(Some(target)) = targets.get(*index) else {
                        continue;
                    };
                    let group = &mut aggregate.groups[*target];
                    if group.stamp == stamp {
                        continue;
                    }
                    group.stamp = stamp;
                    group.visits += visits;
                }
            },
        )?;
    }
    Ok(DayResult {
        scanned: summary.rows,
        matched,
    })
}

const READ_ORDER: [PeriodKind; 2] = [PeriodKind::Months, PeriodKind::Weeks];

fn period_fits(kind: PeriodKind, days: &[String], time: Option<&str>) -> bool {
    match time {
        None => true,
        Some("week") => kind == PeriodKind::Weeks,
        Some("month") => {
            month_of(days.first().map_or("", String::as_str))
                == month_of(days.last().map_or("", String::as_str))
        }
        _ => false,
    }
}

struct Period {
    kind: PeriodKind,
    id: String,
    days: Vec<String>,
    inside: bool,
    source: String,
}

fn list_period_summaries(data_dir: &str, app: &str, from: &str, to: &str) -> Result<Vec<Period>> {
    let mut periods = Vec::new();
    for kind in PERIOD_KINDS {
        for id in list_periods(data_dir, app, kind)? {
            let days = period_days(kind, &id);
            let first = days.first().cloned().unwrap_or_default();
            let last = days.last().cloned().unwrap_or_default();
            if last.as_str() < from || first.as_str() > to {
                continue;
            }
            let inside = first.as_str() >= from && last.as_str() <= to;
            for source in list_period_sources(data_dir, app, kind, &id)? {
                periods.push(Period {
                    kind,
                    id: id.clone(),
                    days: days.clone(),
                    inside,
                    source,
                });
            }
        }
    }
    Ok(periods)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Summary,
    Scan,
    Skipped,
}

struct Run<'a> {
    aggregate: Aggregate,
    days: BTreeSet<String>,
    outcomes: BTreeMap<String, HashMap<String, Outcome>>,
    skipped: Vec<(String, String, String)>,
    scanned: u64,
    matched: u64,
    _query: &'a Query,
}

impl Run<'_> {
    fn add(&mut self, draft: Aggregate, result: DayResult) -> Result<()> {
        for group in draft.groups {
            self.aggregate
                .merge(group.parts, group.records, group.visits);
        }
        if self.aggregate.len() > MAX_GROUPS {
            return Err(query_error(format!(
                "the query makes more than {MAX_GROUPS} groups - group by fewer fields or use a shorter range"
            )));
        }
        self.scanned += result.scanned;
        self.matched += result.matched;
        Ok(())
    }

    fn mark(&mut self, day: &str, source: &str, outcome: Outcome) {
        self.outcomes
            .entry(day.to_string())
            .or_default()
            .insert(source.to_string(), outcome);
    }

    fn skip(&mut self, day: &str, source: &str, reason: String) {
        self.days.insert(day.to_string());
        self.mark(day, source, Outcome::Skipped);
        self.skipped
            .push((day.to_string(), source.to_string(), reason));
    }

    fn has_outcome(&self, day: &str, source: &str) -> bool {
        self.outcomes
            .get(day)
            .is_some_and(|by_source| by_source.contains_key(source))
    }
}

pub fn run_query(data_dir: &str, query: &Query, cancelled: Cancelled) -> Result<Value> {
    let wants_visits = query.wants_visits();
    let use_summary = can_use_summary(query);
    let time = time_field_of(&query.group_by);
    let day_folders: Vec<String> = list_days(data_dir, &query.app)?
        .into_iter()
        .filter(|day| day.as_str() >= query.from.as_str() && day.as_str() <= query.to.as_str())
        .collect();
    let mut day_sources: HashMap<String, Vec<String>> = HashMap::new();
    for day in &day_folders {
        day_sources.insert(day.clone(), list_sources(data_dir, &query.app, day)?);
    }
    let periods = list_period_summaries(data_dir, &query.app, &query.from, &query.to)?;
    let sources: BTreeSet<String> = day_sources
        .values()
        .flatten()
        .cloned()
        .chain(periods.iter().map(|period| period.source.clone()))
        .collect();
    let mut run = Run {
        aggregate: Aggregate::new(),
        days: day_folders.iter().cloned().collect(),
        outcomes: BTreeMap::new(),
        skipped: Vec::new(),
        scanned: 0,
        matched: 0,
        _query: query,
    };
    for source in &sources {
        let own: Vec<&Period> = periods
            .iter()
            .filter(|period| &period.source == source)
            .collect();
        let mut covered: HashSet<String> = HashSet::new();
        let mut used: HashSet<usize> = HashSet::new();
        let mut problems: HashMap<usize, String> = HashMap::new();
        if use_summary {
            for kind in READ_ORDER {
                for (index, period) in own.iter().enumerate() {
                    if cancelled() {
                        return Err(crate::query::cancelled_error());
                    }
                    if period.kind != kind
                        || !period.inside
                        || !period_fits(kind, &period.days, time)
                    {
                        continue;
                    }
                    if period.days.iter().any(|day| covered.contains(day)) {
                        continue;
                    }
                    let mut draft = Aggregate::new();
                    let summary = match read_period_summary(
                        data_dir,
                        &query.app,
                        kind,
                        &period.id,
                        source,
                        wants_visits,
                    ) {
                        Ok(Some(summary)) => summary,
                        Ok(None) => continue,
                        Err(error) => {
                            problems.insert(index, error.message);
                            continue;
                        }
                    };
                    let first = period.days.first().cloned().unwrap_or_default();
                    match summary_day(&summary, &first, query, &mut draft, wants_visits) {
                        Ok(result) => run.add(draft, result)?,
                        Err(error) => {
                            problems.insert(index, error.message);
                            continue;
                        }
                    }
                    used.insert(index);
                    covered.extend(period.days.iter().cloned());
                    if let Some(Value::Object(days)) = &summary.days {
                        for day in days.keys() {
                            run.days.insert(day.clone());
                            run.mark(day, source, Outcome::Summary);
                        }
                    }
                }
            }
        }
        for day in &day_folders {
            if cancelled() {
                return Err(cancelled_error());
            }
            if covered.contains(day)
                || !day_sources
                    .get(day)
                    .is_some_and(|list| list.contains(source))
            {
                continue;
            }
            let path = source_dir(data_dir, &query.app, day, source);
            let mut draft = Aggregate::new();
            let attempt = (|| -> Result<(DayResult, bool)> {
                let summary = if use_summary {
                    read_day_summary(&path, wants_visits, &accept_all)?
                } else {
                    None
                };
                Ok(match summary {
                    Some(summary) => (
                        summary_day(&summary, day, query, &mut draft, wants_visits)?,
                        true,
                    ),
                    None => (
                        scan_day(&path, day, query, &mut draft, wants_visits, cancelled)?,
                        false,
                    ),
                })
            })();
            match attempt {
                Ok((result, from_summary)) => {
                    run.add(draft, result)?;
                    run.mark(
                        day,
                        source,
                        if from_summary {
                            Outcome::Summary
                        } else {
                            Outcome::Scan
                        },
                    );
                }
                Err(error) => {
                    if error.status == Some(504) {
                        return Err(error);
                    }
                    run.skip(day, source, error.message);
                }
            }
        }
        for (index, period) in own.iter().enumerate() {
            if used.contains(&index) {
                continue;
            }
            let mut reason = problems.get(&index).cloned().unwrap_or_else(|| {
                format!("only the summary of the {} is stored", period.kind.name())
            });
            let stored: Vec<String> =
                match read_period_days(data_dir, &query.app, period.kind, &period.id, source) {
                    Ok(days) => days.keys().cloned().collect(),
                    Err(error) => {
                        reason = error.message;
                        period
                            .days
                            .iter()
                            .filter(|day| {
                                !day_sources
                                    .get(*day)
                                    .is_some_and(|list| list.contains(source))
                            })
                            .cloned()
                            .collect()
                    }
                };
            for day in stored {
                let missing = day.as_str() >= query.from.as_str()
                    && day.as_str() <= query.to.as_str()
                    && !covered.contains(&day)
                    && !run.has_outcome(&day, source);
                if missing {
                    run.skip(&day, source, reason.clone());
                }
            }
        }
    }
    let summary_days = run
        .outcomes
        .values()
        .filter(|by_source| {
            by_source
                .values()
                .all(|outcome| *outcome == Outcome::Summary)
        })
        .count();
    let mut skipped = run.skipped.clone();
    skipped.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let groups: Vec<Value> = run
        .aggregate
        .groups
        .iter()
        .map(|group| {
            let mut entry = Object::new()
                .with(
                    "by",
                    Value::Array(
                        group
                            .parts
                            .iter()
                            .map(|part| Value::from(part.clone()))
                            .collect(),
                    ),
                )
                .with("records", group.records);
            if wants_visits {
                entry.insert("visits", group.visits);
            }
            Value::Object(entry)
        })
        .collect();
    Ok(Object::new()
        .with("app", query.app.clone())
        .with("from", query.from.clone())
        .with("to", query.to.clone())
        .with(
            "days",
            Value::Array(run.days.iter().map(Value::from).collect()),
        )
        .with("summaryDays", summary_days)
        .with("scanned", run.scanned)
        .with("matched", run.matched)
        .with(
            "skippedDays",
            Value::Array(
                skipped
                    .into_iter()
                    .map(|(day, source, reason)| {
                        Object::new()
                            .with("day", day)
                            .with("source", source)
                            .with("reason", reason)
                            .into()
                    })
                    .collect(),
            ),
        )
        .with("groups", Value::Array(groups))
        .into())
}
