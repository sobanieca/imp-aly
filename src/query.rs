use crate::column_store::{
    Folders, READ_ATTEMPTS, SealedMeta, accept_all, app_dir, day_dir, dirs_of, generations_of,
    pause, source_dir,
};
use crate::days::{PERIOD_KINDS, PeriodKind, is_day, is_period_id, month_of, period_days};
use crate::error::{Error, Result};
use crate::fast_hash::IdKeys;
use crate::fsutil::{Stamp, stamp_of};
use crate::json::{Object, Value};
use crate::live::{LiveDays, disk_state};
use crate::names::is_source;
use crate::parallel::{default_threads, in_order};
use crate::periods::{
    accepts_period, period_dir, period_source_dir, periods_dir, read_period_days,
};
use crate::query_cache::{
    Draft, IdTable, NO_VALUE, ParsedSummary, QUERY_CACHE_BYTES, QueryCache, SETTLE_MS,
};
use crate::query_core::{
    Aggregate, MAX_GROUPS, Parts, Query, can_use_summary, group_parts, query_error, time_field_of,
};
use crate::scan::scan_day;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

pub type Cancelled<'a> = &'a (dyn Fn() -> bool + Sync);

pub fn cancelled_error() -> Error {
    Error::status(504, "the query was stopped")
}

struct DayResult {
    scanned: u64,
    matched: u64,
}

fn summary_day(
    summary: &ParsedSummary,
    day: &str,
    query: &Query,
    aggregate: &mut Aggregate,
    wants_visits: bool,
) -> DayResult {
    let parts = group_parts(&query.group_by, day);
    let allowed: Vec<Vec<bool>> = query
        .filters
        .iter()
        .map(|filter| {
            (0..summary.values.len())
                .map(|id| filter.matches(summary.value(id as u32)))
                .collect()
        })
        .collect();
    let targets_of = |table: &IdTable, aggregate: &mut Aggregate| -> Vec<Option<usize>> {
        let filter_at: Vec<Option<usize>> = query
            .filters
            .iter()
            .map(|filter| table.position(&filter.field))
            .collect();
        let group_at: Vec<Option<usize>> = parts
            .fields
            .iter()
            .map(|field| table.position(field))
            .collect();
        let mut local = IdKeys::new(group_at.len(), summary.values.len());
        let mut key: Vec<u32> = Vec::with_capacity(group_at.len());
        (0..table.lines())
            .map(|line| {
                let row = table.row(line);
                let cell = |at: &Option<usize>| at.map_or(NO_VALUE, |at| row[at]);
                for (index, at) in filter_at.iter().enumerate() {
                    if !allowed[index][cell(at) as usize] {
                        return None;
                    }
                }
                key.clear();
                key.extend(group_at.iter().map(cell));
                if let Some(target) = local.get(&key) {
                    return Some(target);
                }
                let mut ids = key.iter();
                let group: Parts = parts
                    .time
                    .iter()
                    .map(|value| match value {
                        Some(value) => Some(value.clone()),
                        None => ids
                            .next()
                            .and_then(|id| summary.value(*id))
                            .map(str::to_string),
                    })
                    .collect();
                let target = aggregate.group(group);
                local.insert(&key, target);
                Some(target)
            })
            .collect()
    };
    let mut matched = 0u64;
    for (line, target) in targets_of(&summary.counts, aggregate)
        .into_iter()
        .enumerate()
    {
        let Some(target) = target else {
            continue;
        };
        let records = summary.records[line];
        matched += records;
        aggregate.groups[target].records += records;
    }
    if wants_visits {
        let targets = targets_of(&summary.tuples, aggregate);
        for (line, visits) in summary.visit_counts.iter().enumerate() {
            aggregate.stamp += 1;
            let stamp = aggregate.stamp;
            for index in summary.visit_line(line) {
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
        }
    }
    DayResult {
        scanned: summary.rows,
        matched,
    }
}

fn draft_of(aggregate: Aggregate, result: DayResult) -> Draft {
    Draft {
        groups: aggregate
            .groups
            .into_iter()
            .map(|group| (group.parts, group.records, group.visits))
            .collect(),
        scanned: result.scanned,
        matched: result.matched,
    }
}

fn shape_of(query: &Query, day: &str) -> String {
    let mut shape = format!("{day}\u{0}{}", query.wants_visits());
    for filter in &query.filters {
        let mut values: Vec<&str> = filter.values.iter().map(String::as_str).collect();
        if filter.null {
            values.push("\u{1}");
        }
        values.sort_unstable();
        shape.push_str(&format!(
            "\u{0}{}\u{2}{}",
            filter.field,
            values.join("\u{3}")
        ));
    }
    shape.push_str(&format!("\u{0}{}", query.group_by.join("\u{3}")));
    shape
}

pub struct Sealed {
    summary: Arc<ParsedSummary>,
    path: String,
    stamp: Stamp,
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

fn list_period_summaries(
    folders: &QueryCache,
    threads: usize,
    data_dir: &str,
    app: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Period>> {
    let mut found: Vec<(PeriodKind, String, Vec<String>, bool)> = Vec::new();
    for kind in PERIOD_KINDS {
        let ids = dirs_of(
            &folders.entries(&periods_dir(data_dir, app, kind))?,
            |name| is_period_id(kind, name),
        );
        for id in ids {
            let days = period_days(kind, &id);
            let first = days.first().cloned().unwrap_or_default();
            let last = days.last().cloned().unwrap_or_default();
            if last.as_str() < from || first.as_str() > to {
                continue;
            }
            let inside = first.as_str() >= from && last.as_str() <= to;
            found.push((kind, id, days, inside));
        }
    }
    let mut periods = Vec::new();
    in_order(
        threads,
        &found,
        |(kind, id, ..)| folders.entries(&period_dir(data_dir, app, *kind, id)),
        |at, entries| {
            let (kind, id, days, inside) = &found[at];
            for source in dirs_of(&entries?, is_source) {
                periods.push(Period {
                    kind: *kind,
                    id: id.clone(),
                    days: days.clone(),
                    inside: *inside,
                    source,
                });
            }
            Ok(())
        },
    )?;
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
    fn add(&mut self, draft: &Draft) -> Result<()> {
        for (parts, records, visits) in &draft.groups {
            self.aggregate.merge(parts.clone(), *records, *visits);
        }
        if self.aggregate.len() > MAX_GROUPS {
            return Err(query_error(format!(
                "the query makes more than {MAX_GROUPS} groups - group by fewer fields or use a shorter range"
            )));
        }
        self.scanned += draft.scanned;
        self.matched += draft.matched;
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

struct Plan<'a> {
    source: &'a str,
    own: Vec<&'a Period>,
    covered: HashSet<String>,
    tried: HashSet<usize>,
    used: HashSet<usize>,
    problems: HashMap<usize, String>,
    done: HashSet<String>,
}

impl Plan<'_> {
    fn possible(&self, index: usize) -> bool {
        !self.tried.contains(&index)
            && !self.own[index]
                .days
                .iter()
                .any(|day| self.covered.contains(day))
    }

    fn settled(&self, blockers: &[usize]) -> bool {
        blockers.iter().all(|index| {
            self.own[*index]
                .days
                .iter()
                .any(|day| self.covered.contains(day))
        })
    }
}

struct PeriodItem<'a> {
    plan: usize,
    index: usize,
    period: &'a Period,
}

struct DayItem<'a> {
    plan: usize,
    day: &'a str,
    source: &'a str,
    blockers: Vec<usize>,
}

enum Item<'a> {
    Period(PeriodItem<'a>),
    Day(DayItem<'a>),
}

struct Found {
    draft: Arc<Draft>,
    days: Option<Value>,
    from_summary: bool,
}

fn plan_round<'a>(
    plans: &mut [Plan<'a>],
    day_folders: &'a [String],
    day_sources: &HashMap<String, Vec<String>>,
    usable: &dyn Fn(&Period) -> bool,
) -> Vec<Item<'a>> {
    let mut items = Vec::new();
    for (at, plan) in plans.iter_mut().enumerate() {
        let mut planned = plan.covered.clone();
        for kind in READ_ORDER {
            for (index, period) in plan.own.iter().enumerate() {
                if period.kind != kind
                    || !usable(period)
                    || plan.tried.contains(&index)
                    || period.days.iter().any(|day| planned.contains(day))
                {
                    continue;
                }
                plan.tried.insert(index);
                planned.extend(period.days.iter().cloned());
                items.push(Item::Period(PeriodItem {
                    plan: at,
                    index,
                    period,
                }));
            }
        }
        let mut blocked: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, period) in plan.own.iter().copied().enumerate() {
            if usable(period) && plan.possible(index) {
                for day in &period.days {
                    blocked.entry(day.as_str()).or_default().push(index);
                }
            }
        }
        for day in day_folders {
            let stored = day_sources
                .get(day)
                .is_some_and(|list| list.iter().any(|source| source == plan.source));
            if !stored || planned.contains(day) || plan.done.contains(day) {
                continue;
            }
            let blockers = blocked.get(day.as_str()).cloned().unwrap_or_default();
            items.push(Item::Day(DayItem {
                plan: at,
                day,
                source: plan.source,
                blockers,
            }));
        }
    }
    items
}

pub struct QueryEngine {
    cache: QueryCache,
    live: Option<Arc<LiveDays>>,
    threads: usize,
}

impl Default for QueryEngine {
    fn default() -> Self {
        QueryEngine::new(QUERY_CACHE_BYTES, SETTLE_MS)
    }
}

impl QueryEngine {
    pub fn new(cache_bytes: usize, settle_ms: i64) -> Self {
        QueryEngine {
            cache: QueryCache::new(cache_bytes, settle_ms),
            live: None,
            threads: default_threads(),
        }
    }

    pub fn with_threads(mut self, threads: usize) -> Self {
        self.threads = threads.max(1);
        self
    }

    pub fn with_live(mut self, live: Arc<LiveDays>) -> Self {
        self.live = Some(live);
        self
    }

    fn live_summary(&self, path: &str) -> Result<Option<Arc<ParsedSummary>>> {
        let Some(live) = &self.live else {
            return Ok(None);
        };
        if !live.has(path) {
            return Ok(None);
        }
        let state = disk_state(path)?;
        Ok(live.summary(path, &state))
    }

    pub fn cached_bytes(&self) -> usize {
        self.cache.size()
    }

    fn summary(
        &self,
        path: &str,
        accept: &dyn Fn(&SealedMeta) -> Result<bool>,
    ) -> Result<Option<Sealed>> {
        let sealed = |summary: Arc<ParsedSummary>, stamp: Stamp| Sealed {
            summary,
            path: path.to_string(),
            stamp,
        };
        let mut attempt = 1;
        loop {
            let view = self.cache.view(path)?;
            let generations = generations_of(&view.entries);
            let Some(stamp) = view.stamp else {
                return Ok(None);
            };
            if generations.sealed == 0 || !generations.raws.is_empty() {
                return Ok(None);
            }
            let read = (|| -> Result<Option<(Arc<ParsedSummary>, bool)>> {
                let meta = self.cache.meta(path, stamp, generations.sealed)?;
                if !meta.summary() || !accept(&meta)? {
                    return Ok(None);
                }
                self.cache
                    .summary(path, stamp, generations.sealed, &meta)
                    .map(Some)
            })();
            let changed = || -> Result<bool> { Ok(stamp_of(path)? != Some(stamp)) };
            match read {
                Ok(None) => return Ok(None),
                Ok(Some((summary, true))) => return Ok(Some(sealed(summary, stamp))),
                Ok(Some((summary, false))) => {
                    if !changed()? {
                        return Ok(Some(sealed(summary, stamp)));
                    }
                }
                Err(error) => {
                    if !error.not_found || !changed()? {
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

    fn answer(&self, sealed: &Sealed, day: &str, query: &Query) -> Arc<Draft> {
        let shape = shape_of(query, day);
        if let Some(draft) = self.cache.draft(&sealed.path, sealed.stamp, &shape) {
            return draft;
        }
        let mut aggregate = Aggregate::new();
        let result = summary_day(
            &sealed.summary,
            day,
            query,
            &mut aggregate,
            query.wants_visits(),
        );
        let draft = Arc::new(draft_of(aggregate, result));
        self.cache
            .keep_draft(&sealed.path, sealed.stamp, &shape, draft.clone());
        draft
    }

    pub fn run(&self, data_dir: &str, query: &Query, cancelled: Cancelled) -> Result<Value> {
        run_query(self, data_dir, query, cancelled)
    }
}

fn run_query(
    engine: &QueryEngine,
    data_dir: &str,
    query: &Query,
    cancelled: Cancelled,
) -> Result<Value> {
    let wants_visits = query.wants_visits();
    let use_summary = can_use_summary(query);
    let time = time_field_of(&query.group_by);
    let folders = &engine.cache;
    let day_folders: Vec<String> =
        dirs_of(&folders.entries(&app_dir(data_dir, &query.app))?, is_day)
            .into_iter()
            .filter(|day| day.as_str() >= query.from.as_str() && day.as_str() <= query.to.as_str())
            .collect();
    let mut day_sources: HashMap<String, Vec<String>> = HashMap::new();
    in_order(
        engine.threads,
        &day_folders,
        |day| folders.entries(&day_dir(data_dir, &query.app, day)),
        |at, entries| {
            day_sources.insert(day_folders[at].clone(), dirs_of(&entries?, is_source));
            Ok(())
        },
    )?;
    let periods = list_period_summaries(
        folders,
        engine.threads,
        data_dir,
        &query.app,
        &query.from,
        &query.to,
    )?;
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
    let mut plans: Vec<Plan> = sources
        .iter()
        .map(|source| Plan {
            source,
            own: periods
                .iter()
                .filter(|period| &period.source == source)
                .collect(),
            covered: HashSet::new(),
            tried: HashSet::new(),
            used: HashSet::new(),
            problems: HashMap::new(),
            done: HashSet::new(),
        })
        .collect();
    let read_period = |period: &Period| -> Result<Option<Found>> {
        if cancelled() {
            return Err(cancelled_error());
        }
        let (kind, id, source) = (period.kind, &period.id, &period.source);
        let Some(summary) = engine.summary(
            &period_source_dir(data_dir, &query.app, kind, id, source),
            &accepts_period(folders, data_dir, &query.app, kind, id, source),
        )?
        else {
            return Ok(None);
        };
        let first = period.days.first().cloned().unwrap_or_default();
        Ok(Some(Found {
            draft: engine.answer(&summary, &first, query),
            days: summary.summary.days.clone(),
            from_summary: true,
        }))
    };
    let read_day = |day: &str, source: &str| -> Result<Option<Found>> {
        let found = |draft: Arc<Draft>, from_summary: bool| {
            Some(Found {
                draft,
                days: None,
                from_summary,
            })
        };
        if cancelled() {
            return Err(cancelled_error());
        }
        let path = source_dir(data_dir, &query.app, day, source);
        if use_summary {
            if let Some(summary) = engine.summary(&path, &accept_all)? {
                return Ok(found(engine.answer(&summary, day, query), true));
            }
            if let Some(summary) = engine.live_summary(&path)? {
                let mut aggregate = Aggregate::new();
                let result = summary_day(&summary, day, query, &mut aggregate, wants_visits);
                return Ok(found(Arc::new(draft_of(aggregate, result)), true));
            }
        }
        let draft = scan_day(&path, day, query, wants_visits, cancelled)?;
        Ok(found(Arc::new(draft), false))
    };
    let usable = |period: &Period| {
        use_summary && period.inside && period_fits(period.kind, &period.days, time)
    };
    loop {
        let items = plan_round(&mut plans, &day_folders, &day_sources, &usable);
        if items.is_empty() {
            break;
        }
        in_order(
            engine.threads,
            &items,
            |item| match item {
                Item::Period(item) => read_period(item.period),
                Item::Day(item) => read_day(item.day, item.source),
            },
            |at, outcome| {
                match &items[at] {
                    Item::Period(item) => {
                        let plan = &mut plans[item.plan];
                        match outcome {
                            Ok(Some(found)) => {
                                run.add(&found.draft)?;
                                plan.used.insert(item.index);
                                plan.covered.extend(item.period.days.iter().cloned());
                                if let Some(Value::Object(days)) = &found.days {
                                    for day in days.keys() {
                                        run.days.insert(day.clone());
                                        run.mark(day, plan.source, Outcome::Summary);
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(error) if error.status == Some(504) => return Err(error),
                            Err(error) => {
                                plan.problems.insert(item.index, error.message);
                            }
                        }
                    }
                    Item::Day(item) => {
                        let plan = &mut plans[item.plan];
                        if let Err(error) = &outcome
                            && error.status == Some(504)
                        {
                            return Err(error.clone());
                        }
                        if !plan.settled(&item.blockers) {
                            return Ok(());
                        }
                        plan.done.insert(item.day.to_string());
                        match outcome {
                            Ok(None) => {}
                            Ok(Some(found)) => {
                                run.add(&found.draft)?;
                                run.mark(
                                    item.day,
                                    item.source,
                                    if found.from_summary {
                                        Outcome::Summary
                                    } else {
                                        Outcome::Scan
                                    },
                                );
                            }
                            Err(error) => run.skip(item.day, item.source, error.message),
                        }
                    }
                }
                Ok(())
            },
        )?;
    }
    for plan in &plans {
        let (source, own, covered) = (plan.source, &plan.own, &plan.covered);
        let (used, problems) = (&plan.used, &plan.problems);
        for (index, period) in own.iter().enumerate() {
            let missing = |day: &str| {
                day >= query.from.as_str()
                    && day <= query.to.as_str()
                    && !covered.contains(day)
                    && !run.has_outcome(day, source)
            };
            if used.contains(&index) || !period.days.iter().any(|day| missing(day)) {
                continue;
            }
            let mut reason = problems.get(&index).cloned().unwrap_or_else(|| {
                format!("only the summary of the {} is stored", period.kind.name())
            });
            let stored: Vec<String> = match read_period_days(
                folders,
                data_dir,
                &query.app,
                period.kind,
                &period.id,
                source,
            ) {
                Ok(days) => days.keys().cloned().collect(),
                Err(error) => {
                    reason = error.message;
                    period
                        .days
                        .iter()
                        .filter(|day| {
                            !day_sources
                                .get(*day)
                                .is_some_and(|list| list.iter().any(|stored| stored == source))
                        })
                        .cloned()
                        .collect()
                }
            };
            let missing: Vec<String> = stored.into_iter().filter(|day| missing(day)).collect();
            for day in missing {
                run.skip(&day, source, reason.clone());
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
