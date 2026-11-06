mod support;

use imp_aly::column_store::{keep_only_summary, read_day, read_generations, seal_day};
use imp_aly::days::day_ms;
use imp_aly::json::{self, Value};
use imp_aly::retention::{MinFree, Usage};
use imp_aly::storage::{
    Counts, StorageOptions, StorageRunner, apply_segment, list_held_days, list_unsealed_days,
    parse_segment, seal_due_days,
};
use imp_aly::testing::TempDir;
use imp_aly::wal::{Extension, Wal, WalOptions, list_closed_segments, segment_file_name};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use support::{OTHER_SOURCE, SOURCE};

fn line(app: &str, day: &str, record: &str) -> String {
    format!("[\"{app}\",\"{day}\",{record}]\n")
}

fn error_record(visit: &str, at: i64) -> String {
    format!(r#"{{"type":"error","visit":"{visit}","at":{at},"page":"/"}}"#)
}

fn day_path(data_dir: &str, day: &str, source: &str, app: &str) -> String {
    format!("{data_dir}/apps/{app}/{day}/{source}")
}

fn apply(data_dir: &str, source: &str, segment: u64, text: &str) -> u64 {
    apply_segment(
        data_dir,
        source,
        segment,
        text,
        &mut BTreeMap::new(),
        &mut Counts::default(),
        None,
    )
    .unwrap()
}

fn visits(path: &str) -> Vec<String> {
    let day = read_day(path, &["visit".to_string()]).unwrap();
    day.column("visit")
        .iter()
        .map(|cell| cell.as_deref().unwrap_or("").to_string())
        .collect()
}

fn wait_for(mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "the condition did not happen in time"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn status_number(runner: &StorageRunner, key: &str) -> f64 {
    runner
        .status()
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(-1.0)
}

fn options(data_dir: &str) -> StorageOptions {
    StorageOptions::new(data_dir, SOURCE)
}

#[test]
fn a_segment_groups_records_by_app_and_day_and_skips_bad_lines() {
    let text = line("a", "2026-10-01", &error_record("v", 1))
        + "{\"torn\n"
        + &line("../x", "2026-10-01", "{}")
        + &line("a", "2026-13-01", "{}")
        + &line(
            "a",
            "2026-10-01",
            r#"{"type":"error","bad/key":"x","visit":"w","at":2,"page":"/"}"#,
        )
        + &line("b", "2026-10-02", &error_record("v", 1));
    let mut counts = Counts::default();
    let groups = parse_segment(&text, &mut counts);
    let summary: Vec<(String, String, usize)> = groups
        .iter()
        .map(|group| (group.app.clone(), group.day.clone(), group.records.len()))
        .collect();
    assert_eq!(
        summary,
        [
            ("a".to_string(), "2026-10-01".to_string(), 2),
            ("b".to_string(), "2026-10-02".to_string(), 1)
        ]
    );
    let keys: Vec<&String> = groups[0].records[1].keys().collect();
    assert_eq!(keys, ["type", "visit", "at", "page"]);
    assert_eq!(counts.dropped, 3);
}

#[test]
fn applying_a_segment_twice_stores_it_once() {
    let dir = TempDir::new();
    let text = line("a", "2026-10-01", &error_record("v", 1));
    assert_eq!(apply(&dir.path, SOURCE, 1, &text), 1);
    assert_eq!(apply(&dir.path, SOURCE, 1, &text), 0);
    assert_eq!(
        visits(&day_path(&dir.path, "2026-10-01", SOURCE, "a")).len(),
        1
    );
}

#[test]
fn days_are_sealed_only_after_the_delay() {
    let dir = TempDir::new();
    apply(
        &dir.path,
        SOURCE,
        1,
        &line("a", "2026-10-01", &error_record("v", 1)),
    );
    let day_end = day_ms("2026-10-02").unwrap();
    let mut unsealed = list_unsealed_days(&dir.path, SOURCE).unwrap();
    assert!(seal_due_days(&dir.path, SOURCE, day_end + 10, 60_000, &mut unsealed).is_empty());
    assert_eq!(
        seal_due_days(&dir.path, SOURCE, day_end + 60_000, 60_000, &mut unsealed),
        ["a/2026-10-01"]
    );
    assert_eq!(
        read_generations(&day_path(&dir.path, "2026-10-01", SOURCE, "a"))
            .unwrap()
            .sealed,
        1
    );
}

#[test]
fn a_server_writes_and_seals_only_its_own_source_of_a_day() {
    let dir = TempDir::new();
    let text = line("a", "2026-10-01", &error_record("v", 1));
    apply(&dir.path, SOURCE, 1, &text);
    apply(&dir.path, OTHER_SOURCE, 1, &text);
    let mut unsealed = list_unsealed_days(&dir.path, SOURCE).unwrap();
    let now = day_ms("2026-10-03").unwrap();
    assert_eq!(
        seal_due_days(&dir.path, SOURCE, now, 0, &mut unsealed),
        ["a/2026-10-01"]
    );
    let other = read_generations(&day_path(&dir.path, "2026-10-01", OTHER_SOURCE, "a")).unwrap();
    assert_eq!((other.sealed, other.raws), (0, vec![1]));
}

fn open_wal(data_dir: &str, runner: &StorageRunner) -> Wal {
    let wake = runner.waker();
    Wal::open(WalOptions {
        dir: format!("{data_dir}/wal"),
        segment_ms: 20,
        segment_bytes: 8_388_608,
        on_segment: Box::new(move |_| wake()),
    })
    .unwrap()
}

#[test]
fn the_storage_loop_moves_the_log_into_columns_and_removes_it() {
    let dir = TempDir::new();
    let runner = StorageRunner::start(options(&dir.path)).unwrap();
    let wal = open_wal(&dir.path, &runner);
    wal.append_blocking(line("a", "2026-10-01", &error_record("v", 1)))
        .unwrap();
    wal.append_blocking(line("a", "2026-10-01", &error_record("w", 2)))
        .unwrap();
    wait_for(|| status_number(&runner, "processedRows") == 2.0);
    wal.close();
    runner.stop();
    assert!(
        list_closed_segments(&format!("{}/wal", dir.path))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        visits(&day_path(&dir.path, "2026-10-01", SOURCE, "a")),
        ["v", "w"]
    );
}

#[test]
fn the_worker_stores_only_the_valid_bytes_of_a_part_that_a_failed_write_cut() {
    let dir = TempDir::new();
    let valid = line("a", "2026-10-01", &error_record("v", 1));
    let failed = line("a", "2026-10-01", &error_record("w", 2));
    std::fs::create_dir_all(format!("{}/wal", dir.path)).unwrap();
    let name = segment_file_name(1, Extension::Log, Some(valid.len() as u64));
    std::fs::write(format!("{}/wal/{name}", dir.path), valid + &failed).unwrap();
    let runner = StorageRunner::start(options(&dir.path)).unwrap();
    wait_for(|| status_number(&runner, "processedRows") == 1.0);
    runner.stop();
    assert!(
        list_closed_segments(&format!("{}/wal", dir.path))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        visits(&day_path(&dir.path, "2026-10-01", SOURCE, "a")),
        ["v"]
    );
}

#[test]
fn a_broken_day_does_not_stop_retention_or_the_other_days() {
    let dir = TempDir::new();
    let text = line("a", "2026-09-01", &error_record("v", 1))
        + &line("b", "2026-09-01", &error_record("v", 1));
    apply(&dir.path, SOURCE, 1, &text);
    std::fs::write(
        format!(
            "{}/raw-1/commit.json",
            day_path(&dir.path, "2026-09-01", SOURCE, "a")
        ),
        "{broken",
    )
    .unwrap();
    let mut unsealed = list_unsealed_days(&dir.path, SOURCE).unwrap();
    let now = day_ms("2026-09-03").unwrap();
    assert_eq!(
        seal_due_days(&dir.path, SOURCE, now, 0, &mut unsealed),
        ["b/2026-09-01"]
    );
    let checks = Arc::new(AtomicUsize::new(0));
    let counted = checks.clone();
    let mut options = options(&dir.path);
    options.min_free = Some(MinFree::Percent(10.0));
    options.usage = Arc::new(move |_: &str| {
        counted.fetch_add(1, Ordering::Relaxed);
        Ok(Usage {
            total_bytes: 100,
            free_bytes: 50,
        })
    });
    let runner = StorageRunner::start(options).unwrap();
    wait_for(|| checks.load(Ordering::Relaxed) > 0);
    runner.stop();
}

#[test]
fn a_day_that_fails_keeps_its_records_aside_in_order_also_over_a_restart() {
    let dir = TempDir::new();
    let day = "2026-10-01";
    apply(
        &dir.path,
        SOURCE,
        1,
        &line("a", day, &error_record("v1", 1)),
    );
    let commit = format!(
        "{}/raw-1/commit.json",
        day_path(&dir.path, day, SOURCE, "a")
    );
    let good = std::fs::read_to_string(&commit).unwrap();
    std::fs::write(&commit, "{broken").unwrap();
    let wal = format!("{}/wal", dir.path);
    std::fs::create_dir_all(&wal).unwrap();
    std::fs::write(
        format!("{wal}/{}", segment_file_name(2, Extension::Log, None)),
        line("a", day, &error_record("v2", 1)) + &line("b", day, &error_record("w", 1)),
    )
    .unwrap();
    std::fs::write(
        format!("{wal}/{}", segment_file_name(3, Extension::Log, None)),
        line("a", day, &error_record("v3", 1)),
    )
    .unwrap();
    let mut first_options = options(&dir.path);
    first_options.maintenance_ms = 20;
    let first = StorageRunner::start(first_options.clone()).unwrap();
    wait_for(|| {
        status_number(&first, "processedRows") == 1.0
            && status_number(&first, "pendingSegments") == 0.0
    });
    let held = first.status().get("heldDays").cloned().unwrap();
    assert_eq!(held.as_array().unwrap().len(), 1);
    assert_eq!(
        held.as_array().unwrap()[0].get_str("day"),
        Some("a/2026-10-01")
    );
    assert!(held.as_array().unwrap()[0].get_str("error").is_some());
    first.stop();
    assert!(list_closed_segments(&wal).unwrap().is_empty());
    assert_eq!(visits(&day_path(&dir.path, day, SOURCE, "b")), ["w"]);
    assert_eq!(list_held_days(&dir.path).unwrap(), ["a/2026-10-01"]);
    std::fs::write(&commit, good).unwrap();
    let second = StorageRunner::start(first_options).unwrap();
    wait_for(|| status_number(&second, "processedRows") == 2.0);
    second.stop();
    assert_eq!(
        json::stringify(second.status().get("heldDays").unwrap()),
        "[]"
    );
    assert!(list_held_days(&dir.path).unwrap().is_empty());
    assert_eq!(
        visits(&day_path(&dir.path, day, SOURCE, "a")),
        ["v1", "v2", "v3"]
    );
}

#[test]
fn the_seal_pass_takes_only_the_days_that_it_knows_to_be_unsealed() {
    let dir = TempDir::new();
    let record = error_record("v", 1);
    apply(&dir.path, SOURCE, 1, &line("a", "2026-09-01", &record));
    apply(&dir.path, SOURCE, 1, &line("b", "2026-09-02", &record));
    seal_day(&day_path(&dir.path, "2026-09-01", SOURCE, "a")).unwrap();
    let mut unsealed = list_unsealed_days(&dir.path, SOURCE).unwrap();
    assert_eq!(unsealed.iter().collect::<Vec<_>>(), ["b/2026-09-02"]);
    apply(&dir.path, SOURCE, 2, &line("c", "2026-09-03", &record));
    let now = day_ms("2026-10-01").unwrap();
    assert_eq!(
        seal_due_days(&dir.path, SOURCE, now, 0, &mut unsealed),
        ["b/2026-09-02"]
    );
    assert!(unsealed.is_empty());
    assert_eq!(
        read_generations(&day_path(&dir.path, "2026-09-03", SOURCE, "c"))
            .unwrap()
            .raws,
        [1]
    );
}

#[test]
fn the_storage_loop_seals_the_days_that_it_stored_without_a_new_scan() {
    let dir = TempDir::new();
    let record = error_record("v", 1);
    apply(&dir.path, SOURCE, 1, &line("a", "2026-09-01", &record));
    let mut storage_options = options(&dir.path);
    storage_options.seal_delay_ms = 0;
    storage_options.maintenance_ms = 20;
    let runner = StorageRunner::start(storage_options).unwrap();
    let generations =
        |app: &str, day: &str| read_generations(&day_path(&dir.path, day, SOURCE, app)).unwrap();
    wait_for(|| generations("a", "2026-09-01").sealed == 1);
    apply(&dir.path, SOURCE, 2, &line("b", "2026-09-02", &record));
    let wal = open_wal(&dir.path, &runner);
    wal.append_blocking(line("c", "2026-09-03", &record))
        .unwrap();
    wait_for(|| generations("c", "2026-09-03").sealed > 0);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(generations("b", "2026-09-02").raws, [1]);
    wal.close();
    runner.stop();
}

#[test]
fn records_that_cannot_be_stored_are_counted_in_the_status() {
    let dir = TempDir::new();
    let day = "2026-09-01";
    let record = error_record("v", 1);
    apply(&dir.path, SOURCE, 1, &line("a", day, &record));
    seal_day(&day_path(&dir.path, day, SOURCE, "a")).unwrap();
    assert!(keep_only_summary(&day_path(&dir.path, day, SOURCE, "a")).unwrap());
    let mut counts = Counts::default();
    let rows = apply_segment(
        &dir.path,
        SOURCE,
        2,
        &line("a", day, &record),
        &mut BTreeMap::new(),
        &mut counts,
        None,
    )
    .unwrap();
    assert_eq!((rows, counts.dropped), (0, 1));
    std::fs::create_dir_all(format!("{}/wal", dir.path)).unwrap();
    std::fs::write(
        format!(
            "{}/wal/{}",
            dir.path,
            segment_file_name(3, Extension::Log, None)
        ),
        line("a", day, &record) + &line("a", day, &record) + "{\"torn\n",
    )
    .unwrap();
    let runner = StorageRunner::start(options(&dir.path)).unwrap();
    wait_for(|| status_number(&runner, "droppedRecords") == 3.0);
    runner.stop();
}

#[test]
fn the_worker_builds_the_running_summary_of_an_open_day_at_start_and_adds_each_part() {
    let dir = TempDir::new();
    let today = imp_aly::days::day_of(imp_aly::days::now_ms());
    apply(
        &dir.path,
        SOURCE,
        1,
        &line("a", &today, &error_record("v", 1)),
    );
    let options = options(&dir.path);
    let live = options.live.clone();
    let path = day_path(&dir.path, &today, SOURCE, "a");
    let runner = StorageRunner::start(options).unwrap();
    wait_for(|| live.has(&path));
    let wal = open_wal(&dir.path, &runner);
    wal.append_blocking(line("a", &today, &error_record("w", 2)))
        .unwrap();
    wait_for(|| status_number(&runner, "processedRows") == 1.0);
    let query = imp_aly::query_core::parse_query(
        &imp_aly::json::parse(r#"{"app":"a","groupBy":["visit"]}"#).unwrap(),
        imp_aly::days::now_ms(),
    )
    .unwrap();
    let summary = imp_aly::query_core::parse_query(
        &imp_aly::json::parse(r#"{"app":"a","measures":["records","visits"]}"#).unwrap(),
        imp_aly::days::now_ms(),
    )
    .unwrap();
    let engine = imp_aly::query::QueryEngine::default().with_live(live.clone());
    let answer = engine.run(&dir.path, &summary, &|| false).unwrap();
    assert_eq!(answer.get("summaryDays").unwrap().as_f64(), Some(1.0));
    let groups = answer.get("groups").unwrap().as_array().unwrap();
    assert_eq!(groups[0].get("records").unwrap().as_f64(), Some(2.0));
    assert_eq!(groups[0].get("visits").unwrap().as_f64(), Some(2.0));
    let scanned = engine.run(&dir.path, &query, &|| false).unwrap();
    assert_eq!(scanned.get("summaryDays").unwrap().as_f64(), Some(0.0));
    wal.close();
    runner.stop();
}
