mod support;

use imp_aly::column_store::{SummaryFiles, is_summary_only_day, seal_day, write_summary_day};
use imp_aly::days::parse_iso;
use imp_aly::error::Result;
use imp_aly::json::{self, Value};
use imp_aly::query_core::{Query, parse_query};
use imp_aly::retention::{MinFree, Usage, enforce_retention};
use imp_aly::storage::{apply_segment_text, seal_due_periods};
use imp_aly::testing::TempDir;
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use support::*;

fn now() -> i64 {
    parse_iso("2026-10-01T12:00:00Z").unwrap()
}

fn record_line(app: &str, day: &str) -> String {
    format!(
        "[\"{app}\",\"{day}\",{{\"type\":\"error\",\"visit\":\"v\",\"at\":1,\"page\":\"/\"}}]\n"
    )
}

fn queue(values: &[u64]) -> impl Fn(&str) -> Result<Usage> + Send + Sync {
    let free = Mutex::new(values.iter().copied().collect::<VecDeque<_>>());
    move |_| {
        Ok(Usage {
            total_bytes: 100,
            free_bytes: free.lock().unwrap().pop_front().unwrap_or(100),
        })
    }
}

fn zeros(count: usize) -> impl Fn(&str) -> Result<Usage> + Send + Sync {
    let calls = AtomicUsize::new(0);
    move |_| {
        let call = calls.fetch_add(1, Ordering::Relaxed);
        Ok(Usage {
            total_bytes: 100,
            free_bytes: if call < count { 0 } else { 100 },
        })
    }
}

fn parse(fields: &str) -> Query {
    let mut value = json::parse(fields).unwrap();
    if let Value::Object(object) = &mut value {
        object.insert("app", "myapp");
    }
    parse_query(&value, now()).unwrap()
}

#[test]
fn the_oldest_days_go_first_until_the_disk_has_room_and_today_stays() {
    let dir = TempDir::new();
    let mut segment = 0;
    for day in ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"] {
        for app in ["a", "b"] {
            segment += 1;
            apply_segment_text(&dir.path, SOURCE, segment, &record_line(app, day)).unwrap();
        }
    }
    let free = Mutex::new(0u64);
    let usage = |path: &str| -> Result<Usage> {
        let mut remaining = 0u64;
        for app in std::fs::read_dir(format!("{path}/apps")).unwrap() {
            remaining += std::fs::read_dir(app.unwrap().path()).unwrap().count() as u64;
        }
        *free.lock().unwrap() = 100 - remaining * 10;
        Ok(Usage {
            total_bytes: 100,
            free_bytes: 100 - remaining * 10,
        })
    };
    let result = enforce_retention(&dir.path, MinFree::Percent(55.0), &usage, now()).unwrap();
    assert_eq!(
        result.removed,
        [
            "a/2026-09-28",
            "b/2026-09-28",
            "a/2026-09-29",
            "b/2026-09-29"
        ]
    );
    assert_eq!(*free.lock().unwrap(), 60);
    let all = enforce_retention(&dir.path, MinFree::Percent(99.0), &usage, now()).unwrap();
    assert_eq!(all.removed, ["a/2026-09-30", "b/2026-09-30"]);
    assert_eq!(*free.lock().unwrap(), 80);
}

#[test]
fn days_with_records_go_before_older_days_that_hold_only_a_summary() {
    let dir = TempDir::new();
    write_summary_day(
        &format!("{}/apps/a/2026-09-01/{SOURCE}", dir.path),
        0,
        &SummaryFiles {
            counts: "type\tpage\tzone\tname\tcountry\trecords\n".to_string(),
            tuples: "type\tpage\tcountry\n".to_string(),
            visits: "visits\ttuples\n".to_string(),
        },
    )
    .unwrap();
    apply_segment_text(&dir.path, SOURCE, 1, &record_line("a", "2026-09-30")).unwrap();
    let result = enforce_retention(&dir.path, MinFree::Percent(10.0), &zeros(2), now()).unwrap();
    assert_eq!(result.removed, ["a/2026-09-30", "a/2026-09-01"]);
}

#[test]
fn the_retention_keeps_the_summary_of_a_sealed_day_before_it_removes_days() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    let query = parse(&format!(r#"{{"from":"{}","groupBy":["page"]}}"#, DAYS[1]));
    let before = ask(&dir.path, &query);
    let result = enforce_retention(
        &dir.path,
        MinFree::Percent(10.0),
        &queue(&[0, 0, 0, 100]),
        now(),
    )
    .unwrap();
    assert_eq!(result.summarized, DAYS.map(|day| format!("myapp/{day}")));
    assert_eq!(result.removed, [format!("myapp/{}", DAYS[0])]);
    let path = day_path(&dir.path, DAYS[1], SOURCE);
    assert!(is_summary_only_day(&path).unwrap());
    let mut files: Vec<String> = std::fs::read_dir(format!("{path}/sealed-2"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    assert_eq!(
        files,
        [
            "meta.json",
            "summary-counts.tsv",
            "summary-tuples.tsv",
            "summary-visits.tsv"
        ]
    );
    assert_eq!(ask(&dir.path, &query), before);
}

#[test]
fn a_day_without_a_summary_stays_while_the_summaries_of_newer_days_free_enough() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    seal_day(&day_path(&dir.path, DAYS[1], SOURCE)).unwrap();
    let result =
        enforce_retention(&dir.path, MinFree::Percent(10.0), &queue(&[0, 100]), now()).unwrap();
    assert_eq!(result.summarized, [format!("myapp/{}", DAYS[1])]);
    assert!(result.removed.is_empty());
    assert!(!is_summary_only_day(&day_path(&dir.path, DAYS[0], SOURCE)).unwrap());
}

#[test]
fn the_retention_removes_the_days_of_a_period_then_the_weeks_then_the_months() {
    let list = days(&[
        "2026-08-31",
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
    ]);
    let dir = fill(&list, SOURCE, &all);
    seal_all(&dir.path, SOURCE, &list);
    seal_due_periods(&dir.path, SOURCE, now(), 0, &mut HashSet::new());
    let by_week = parse(
        r#"{"from":"2026-08-31","to":"2026-09-30","measures":["visits"],"groupBy":["week"]}"#,
    );
    let by_month = parse(
        r#"{"from":"2026-08-01","to":"2026-09-30","measures":["visits"],"groupBy":["month"]}"#,
    );
    let before = [ask(&dir.path, &by_week), ask(&dir.path, &by_month)];
    let first = enforce_retention(
        &dir.path,
        MinFree::Percent(10.0),
        &zeros(list.len() * 2),
        now(),
    )
    .unwrap();
    let names: Vec<String> = list.iter().map(|day| format!("myapp/{day}")).collect();
    assert_eq!(first.summarized, names);
    assert_eq!(first.removed, names);
    assert_eq!(
        [ask(&dir.path, &by_week), ask(&dir.path, &by_month)],
        before
    );
    let second =
        enforce_retention(&dir.path, MinFree::Percent(10.0), &zeros(usize::MAX), now()).unwrap();
    assert_eq!(
        second.removed,
        [
            "myapp/weeks/2026-08-31",
            "myapp/months/2026-08",
            "myapp/months/2026-09"
        ]
    );
}
