use crate::column_store::{
    DaySummary, SealedMeta, SummaryFiles, accept_all, app_dir, list_sources_in, read_day_summary,
    read_generations, read_sealed_meta, source_dir, write_summary_period,
};
use crate::days::{PERIOD_KINDS, PeriodKind, day_end_ms, is_period_id, period_days, period_of};
use crate::error::{Error, Result};
use crate::fsutil::list_directory;
use crate::json::{Object, Value};
use crate::paths::join;
use crate::summary::{SummaryMerger, SummaryText};
use std::collections::{BTreeMap, HashSet};

pub fn periods_dir(data_dir: &str, app: &str, kind: PeriodKind) -> String {
    join(&[&app_dir(data_dir, app), kind.dir()])
}

pub fn period_dir(data_dir: &str, app: &str, kind: PeriodKind, id: &str) -> String {
    join(&[&periods_dir(data_dir, app, kind), id])
}

pub fn period_source_dir(
    data_dir: &str,
    app: &str,
    kind: PeriodKind,
    id: &str,
    source: &str,
) -> String {
    join(&[&period_dir(data_dir, app, kind, id), source])
}

pub fn list_periods(data_dir: &str, app: &str, kind: PeriodKind) -> Result<Vec<String>> {
    let mut ids: Vec<String> = list_directory(&periods_dir(data_dir, app, kind))?
        .into_iter()
        .filter(|entry| entry.is_dir && is_period_id(kind, &entry.name))
        .map(|entry| entry.name)
        .collect();
    ids.sort();
    Ok(ids)
}

pub fn list_period_sources(
    data_dir: &str,
    app: &str,
    kind: PeriodKind,
    id: &str,
) -> Result<Vec<String>> {
    list_sources_in(&period_dir(data_dir, app, kind, id))
}

pub fn period_end_ms(kind: PeriodKind, id: &str) -> i64 {
    day_end_ms(period_days(kind, id).last().map_or("", String::as_str))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DayState {
    pub rows: u64,
    pub wal: u64,
}

pub type DayStates = BTreeMap<String, DayState>;

fn count(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_safe_integer)
        .and_then(|number| u64::try_from(number).ok())
}

pub fn check_period_days(kind: PeriodKind, id: &str, days: Option<&Value>) -> Result<DayStates> {
    let invalid = || {
        Error::new(format!(
            "the days of the summary of {}/{id} are not valid",
            kind.dir()
        ))
    };
    let Some(Value::Object(days)) = days else {
        return Err(invalid());
    };
    let allowed = period_days(kind, id);
    let mut states = DayStates::new();
    for (day, state) in days.iter() {
        if !allowed.contains(day) {
            return Err(invalid());
        }
        let rows = count(state.get("rows")).ok_or_else(invalid)?;
        let wal = count(state.get("wal")).ok_or_else(invalid)?;
        states.insert(day.clone(), DayState { rows, wal });
    }
    Ok(states)
}

pub fn read_day_states(
    data_dir: &str,
    app: &str,
    kind: PeriodKind,
    id: &str,
    source: &str,
) -> Result<Option<DayStates>> {
    let mut days = DayStates::new();
    for day in period_days(kind, id) {
        let path = source_dir(data_dir, app, &day, source);
        let generations = read_generations(&path)?;
        if generations.sealed == 0 && generations.raws.is_empty() {
            continue;
        }
        if !generations.raws.is_empty() {
            return Ok(None);
        }
        let Ok(meta) = read_sealed_meta(&join(&[&path, &format!("sealed-{}", generations.sealed)]))
        else {
            return Ok(None);
        };
        if !meta.summary() {
            return Ok(None);
        }
        days.insert(
            day,
            DayState {
                rows: meta.rows,
                wal: meta.wal,
            },
        );
    }
    Ok(Some(days))
}

pub fn matches_days(recorded: &DayStates, states: Option<&DayStates>) -> bool {
    let Some(states) = states else {
        return false;
    };
    states
        .iter()
        .all(|(day, state)| recorded.get(day) == Some(state))
}

pub fn read_period_summary(
    data_dir: &str,
    app: &str,
    kind: PeriodKind,
    id: &str,
    source: &str,
    with_visits: bool,
) -> Result<Option<DaySummary>> {
    let accept = |meta: &SealedMeta| -> Result<bool> {
        let recorded = check_period_days(kind, id, meta.days())?;
        let states = read_day_states(data_dir, app, kind, id, source)?;
        Ok(matches_days(&recorded, states.as_ref()))
    };
    read_day_summary(
        &period_source_dir(data_dir, app, kind, id, source),
        with_visits,
        &accept,
    )
}

pub fn read_period_days(
    data_dir: &str,
    app: &str,
    kind: PeriodKind,
    id: &str,
    source: &str,
) -> Result<DayStates> {
    let path = period_source_dir(data_dir, app, kind, id, source);
    let generations = read_generations(&path)?;
    if generations.sealed == 0 {
        return Ok(DayStates::new());
    }
    let meta = read_sealed_meta(&join(&[&path, &format!("sealed-{}", generations.sealed)]))?;
    check_period_days(kind, id, meta.days())
}

pub fn days_value(states: &DayStates) -> Value {
    let mut object = Object::new();
    for (day, state) in states {
        object.insert(
            day.clone(),
            Object::new()
                .with("rows", state.rows)
                .with("wal", state.wal),
        );
    }
    object.into()
}

pub fn update_period_summary(
    data_dir: &str,
    app: &str,
    kind: PeriodKind,
    id: &str,
    source: &str,
) -> Result<bool> {
    let Some(states) = read_day_states(data_dir, app, kind, id, source)? else {
        return Ok(false);
    };
    if states.is_empty() {
        return Ok(false);
    }
    let path = period_source_dir(data_dir, app, kind, id, source);
    if read_generations(&path)?.sealed > 0
        && let Ok(recorded) = read_period_days(data_dir, app, kind, id, source)
        && matches_days(&recorded, Some(&states))
    {
        return Ok(false);
    }
    let mut merger = SummaryMerger::new();
    let mut days = DayStates::new();
    for day in states.keys() {
        let Some(summary) =
            read_day_summary(&source_dir(data_dir, app, day, source), true, &accept_all)?
        else {
            return Ok(false);
        };
        merger.add(&SummaryText {
            counts: &summary.counts,
            tuples: summary.tuples.as_deref().unwrap_or(""),
            visits: summary.visits.as_deref().unwrap_or(""),
        })?;
        days.insert(
            day.clone(),
            DayState {
                rows: summary.rows,
                wal: summary.wal,
            },
        );
    }
    let (rows, files) = merger.finish();
    let (counts, tuples, visits) = files.joined();
    write_summary_period(
        &path,
        rows,
        days_value(&days),
        &SummaryFiles {
            counts,
            tuples,
            visits,
        },
    )?;
    Ok(true)
}

pub struct DuePeriod {
    pub key: String,
    pub app: String,
    pub kind: PeriodKind,
    pub id: String,
}

pub fn due_periods(
    days: &[(String, String)],
    now: i64,
    seal_delay_ms: i64,
    checked: &HashSet<String>,
) -> Vec<DuePeriod> {
    let mut due: Vec<DuePeriod> = Vec::new();
    let mut seen = HashSet::new();
    for (app, day) in days {
        for kind in PERIOD_KINDS {
            let id = period_of(kind, day);
            let key = format!("{app}/{}/{id}", kind.dir());
            if checked.contains(&key) || seen.contains(&key) {
                continue;
            }
            if now < period_end_ms(kind, &id) + seal_delay_ms {
                continue;
            }
            seen.insert(key.clone());
            due.push(DuePeriod {
                key,
                app: app.clone(),
                kind,
                id,
            });
        }
    }
    due
}
