use crate::demo_data::{DemoApp, Random, SHOP, visit_records};
use imp_aly::column_store::{append_records, seal_day, source_dir};
use imp_aly::days::{DAY_MS, day_ms, day_of, now_ms};
use imp_aly::json::{self, Object, Value};
use imp_aly::live::{LiveDays, build_from_disk};
use imp_aly::query::QueryEngine;
use imp_aly::query_core::{Query, parse_query};
use imp_aly::storage::seal_due_periods;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

const SOURCE: &str = "0123456789abcdef";

const BENCH_APP: DemoApp = DemoApp {
    segments: &["plan", "locale", "channel"],
    segment_values: &[
        (
            "plan",
            &[
                (Some("free"), 60.0),
                (Some("pro"), 25.0),
                (Some("team"), 10.0),
                (None, 5.0),
            ],
        ),
        (
            "locale",
            &[
                (Some("en"), 40.0),
                (Some("de"), 15.0),
                (Some("fr"), 10.0),
                (Some("pl"), 10.0),
                (Some("es"), 8.0),
                (Some("it"), 7.0),
                (Some("nl"), 5.0),
                (Some("sv"), 5.0),
            ],
        ),
        (
            "channel",
            &[
                (Some("direct"), 30.0),
                (Some("search"), 25.0),
                (Some("social"), 10.0),
                (Some("email"), 8.0),
                (Some("partner"), 5.0),
                (Some("ads-a"), 4.0),
                (Some("ads-b"), 4.0),
                (Some("ads-c"), 3.0),
                (Some("news"), 3.0),
                (Some("app"), 3.0),
                (Some("blog"), 3.0),
                (None, 2.0),
            ],
        ),
    ],
    ..SHOP
};

const APP: &str = "shop";

const HISTORY_DAYS: i64 = 180;

const HISTORY_VISITS: usize = 3_000;

const TODAY_RECORDS: usize = 1_000_000;

const BIG_RECORDS: usize = 10_000_000;

const BATCH_RECORDS: usize = 100_000;

const READY_FILE: &str = "ready.json";

const RUNS: usize = 5;

const OVERVIEW: [&str; 4] = [
    r#"{"groupBy":["week"],"measures":["visits"],"limit":100000}"#,
    r#"{"groupBy":["type"],"measures":["records","visits"]}"#,
    r#"{"where":{"type":"page"},"groupBy":["page"],"measures":["records"],"limit":100000}"#,
    r#"{"where":{"type":"outcome"},"groupBy":["name"],"measures":["records"],"limit":100000}"#,
];

const SCAN: &str = r#"{"groupBy":["zone","page"],"measures":["records","visits"]}"#;

fn write_day(data_dir: &str, day: &str, records: Option<usize>, random: &mut Random) -> usize {
    let start = day_ms(day).unwrap_or(0);
    let raw = format!("{}/raw-1", source_dir(data_dir, APP, day, SOURCE));
    let mut batch: Vec<Object> = Vec::new();
    let mut segment = 1;
    let mut written = 0;
    let mut visit = 0;
    let flush = |batch: &mut Vec<Object>, segment: &mut u64| {
        if batch.is_empty() {
            return;
        }
        append_records(&raw, *segment, batch, 0).expect("append records");
        *segment += 1;
        batch.clear();
    };
    loop {
        let done = match records {
            Some(target) => written >= target,
            None => visit >= HISTORY_VISITS,
        };
        if done {
            break;
        }
        let at = start + (random.next() * (DAY_MS - 3_600_000) as f64) as i64;
        let made = visit_records(&BENCH_APP, random, &format!("d{day}v{visit}"), at, false);
        visit += 1;
        for mut record in made.records {
            if records.is_some_and(|target| written >= target) {
                break;
            }
            record.insert("country", made.country);
            batch.push(record);
            written += 1;
            if batch.len() == BATCH_RECORDS {
                flush(&mut batch, &mut segment);
            }
        }
    }
    flush(&mut batch, &mut segment);
    written
}

fn make_data(root: &str) -> String {
    let _ = std::fs::remove_dir_all(root);
    let main = format!("{root}/main");
    let big = format!("{root}/big");
    let today = day_of(now_ms());
    let start = day_ms(&today).unwrap_or(0);
    let mut random = Random::new(42.0);
    println!("Writing {HISTORY_DAYS} sealed days...");
    let mut history = 0;
    for back in (1..=HISTORY_DAYS).rev() {
        let day = day_of(start - back * DAY_MS);
        history += write_day(&main, &day, None, &mut random);
        seal_day(&source_dir(&main, APP, &day, SOURCE)).expect("seal a day");
    }
    seal_due_periods(&main, SOURCE, start, 0, &mut HashSet::new());
    println!("Wrote {history} records in sealed days");
    println!("Writing {TODAY_RECORDS} records of today...");
    write_day(&main, &today, Some(TODAY_RECORDS), &mut random);
    println!("Writing {BIG_RECORDS} records of one day...");
    write_day(&big, &today, Some(BIG_RECORDS), &mut random);
    std::fs::write(
        format!("{root}/{READY_FILE}"),
        json::stringify(&Object::new().with("today", today.clone()).into()),
    )
    .expect("write the ready file");
    today
}

fn query_of(fields: &str, from: &str, to: &str) -> Query {
    let mut value = json::parse(fields).expect("a query");
    if let Value::Object(object) = &mut value {
        object.insert("app", APP);
        object.insert("from", from);
        object.insert("to", to);
    }
    parse_query(&value, now_ms()).expect("a valid query")
}

fn run_all(engine: &QueryEngine, data_dir: &str, queries: &[Query]) -> (f64, Vec<String>) {
    let started = Instant::now();
    let answers = queries
        .iter()
        .map(|query| json::stringify(&engine.run(data_dir, query, &|| false).expect("an answer")))
        .collect();
    (started.elapsed().as_secs_f64() * 1000.0, answers)
}

fn peak_memory_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap_or(0)
}

pub fn scan_child(args: &[String]) -> bool {
    let (Some(data_dir), Some(day)) = (args.first(), args.get(1)) else {
        eprintln!("Usage: cargo xtask bench-scan <folder> <day>");
        return false;
    };
    let before = peak_memory_kb();
    let (ms, _) = run_all(
        &QueryEngine::default(),
        data_dir,
        &[query_of(SCAN, day, day)],
    );
    println!("{ms:.0} {before} {}", peak_memory_kb());
    true
}

fn median(mut times: Vec<f64>) -> f64 {
    times.sort_by(f64::total_cmp);
    times[times.len() / 2]
}

fn line(label: &str, ms: f64) {
    println!("{label:<52} {ms:>9.1} ms");
}

pub fn bench(root: &Path, args: &[String]) -> bool {
    let root = root.join(".bench-data").display().to_string();
    let ready = std::fs::read_to_string(format!("{root}/{READY_FILE}"))
        .ok()
        .and_then(|text| json::parse(&text).ok())
        .and_then(|value| value.get_str("today").map(str::to_string));
    let today = match ready {
        Some(today) if !args.iter().any(|arg| arg == "--reset") => today,
        _ => make_data(&root),
    };
    imp_aly::logger::set_quiet(true);
    let main = format!("{root}/main");
    let big = format!("{root}/big");
    let start = day_ms(&today).unwrap_or(0);
    let from = day_of(start - HISTORY_DAYS * DAY_MS);
    let to = day_of(start - DAY_MS);
    let history: Vec<Query> = OVERVIEW
        .iter()
        .map(|fields| query_of(fields, &from, &to))
        .collect();
    let current: Vec<Query> = OVERVIEW
        .iter()
        .map(|fields| query_of(fields, &today, &today))
        .collect();
    let mut firsts = Vec::new();
    let mut seconds = Vec::new();
    let mut answers = None;
    for _ in 0..RUNS {
        let engine = QueryEngine::default();
        let (first, first_answers) = run_all(&engine, &main, &history);
        firsts.push(first);
        for _ in 0..RUNS {
            let (second, again) = run_all(&engine, &main, &history);
            seconds.push(second);
            assert_eq!(first_answers, again, "a cached run gives another answer");
        }
        if let Some(previous) = &answers {
            assert_eq!(previous, &first_answers, "two runs give other answers");
        }
        answers = Some(first_answers);
    }
    line("Overview of 180 sealed days, first run", median(firsts));
    line("Overview of 180 sealed days, cached run", median(seconds));
    let long_scan = [query_of(SCAN, &from, &to)];
    let mut by_threads = Vec::new();
    for threads in [1, 4] {
        let firsts = (0..RUNS)
            .map(|_| {
                let engine = QueryEngine::default().with_threads(threads);
                run_all(&engine, &main, &history)
            })
            .collect::<Vec<_>>();
        let engine = QueryEngine::default().with_threads(threads);
        let scans = (0..3)
            .map(|_| run_all(&engine, &main, &long_scan))
            .collect::<Vec<_>>();
        line(
            &format!("Overview of 180 sealed days, first run, {threads} cores"),
            median(firsts.iter().map(|(ms, _)| *ms).collect()),
        );
        line(
            &format!("Scan of 180 sealed days, {threads} cores"),
            median(scans.iter().map(|(ms, _)| *ms).collect()),
        );
        by_threads.push((firsts[0].1.clone(), scans[0].1.clone()));
    }
    assert_eq!(
        by_threads[0], by_threads[1],
        "1 and 4 cores give other answers"
    );
    let path = source_dir(&main, APP, &today, SOURCE);
    let started = Instant::now();
    let (summary, state) = build_from_disk(&path).expect("build the running summary");
    line(
        "Running summary of 1M records, built from the disk",
        started.elapsed().as_secs_f64() * 1000.0,
    );
    let live = Arc::new(LiveDays::default());
    live.put(&path, summary, state);
    let engine = QueryEngine::default().with_live(live);
    let (first, _) = run_all(&engine, &main, &current[..1]);
    line(
        "First query of today at 1M records, after new records",
        first,
    );
    let times = (0..RUNS)
        .map(|_| run_all(&engine, &main, &current).0)
        .collect();
    line("Overview of today at 1M records", median(times));
    let scan = [query_of(SCAN, &today, &today)];
    let times = (0..RUNS)
        .map(|_| run_all(&engine, &main, &scan).0)
        .collect();
    line("Scan of 1M records", median(times));
    let exe = std::env::current_exe().expect("the path of xtask");
    let output = Command::new(exe)
        .args(["bench-scan", &big, &today])
        .output()
        .expect("run the scan of 10M records");
    let text = String::from_utf8_lossy(&output.stdout);
    let numbers: Vec<f64> = text
        .split_whitespace()
        .filter_map(|word| word.parse().ok())
        .collect();
    if let [ms, before, after] = numbers[..] {
        line("Scan of 10M records", ms);
        println!(
            "{:<52} {:>9.1} MB (before the scan {:.1} MB)",
            "Peak memory of the scan of 10M records",
            after / 1024.0,
            before / 1024.0
        );
    } else {
        eprintln!("The scan of 10M records failed: {text}");
        return false;
    }
    true
}
