mod support;

use imp_aly::backup::{count_backup, restore_backup_file, write_backup};
use imp_aly::column_store::{SUMMARY_ONLY_PROBLEM, seal_day};
use imp_aly::days::{DAY_MS, day_ms, day_of};
use imp_aly::json::{self, Value};
use imp_aly::query_core::{Query, ServerAnswer, can_use_summary, finalize_query, parse_query};
use imp_aly::storage::{apply_segment_text, seal_due_periods};
use imp_aly::testing::TempDir;
use std::collections::HashSet;
use std::fs::File;
use support::*;

const QUERIES: [&str; 16] = [
    r#"{"measures":["records","visits"]}"#,
    r#"{"groupBy":["day"],"measures":["visits","records"]}"#,
    r#"{"groupBy":["page","type"],"measures":["records","visits"]}"#,
    r#"{"where":{"type":"page"},"groupBy":["week","page"],"measures":["visits","records"]}"#,
    r#"{"groupBy":["month"],"measures":["visits","records"]}"#,
    r#"{"groupBy":["country","week"],"measures":["visits"]}"#,
    r#"{"where":{"type":["seen","used"]},"groupBy":["zone","type","month"]}"#,
    r#"{"where":{"type":["page","used"],"zone":null},"groupBy":["page","type","week"]}"#,
    r#"{"where":{"type":"outcome","page":"/invoices/:id"},"groupBy":["name"]}"#,
    r#"{"where":{"country":"PL","plan":"pro"},"groupBy":["day"],"measures":["records","visits"]}"#,
    r#"{"where":{"plan":null},"groupBy":["country","plan"],"measures":["visits"]}"#,
    r#"{"groupBy":["plan","country","day"],"measures":["visits","records"]}"#,
    r#"{"where":{"zone":"myapp.zone-1"},"measures":["visits"]}"#,
    r#"{"groupBy":["visit"],"measures":["records"],"limit":5}"#,
    r#"{"groupBy":["week"],"measures":["visits","records"]}"#,
    r#"{"where":{"type":"page"},"groupBy":["month","plan"],"measures":["visits"]}"#,
];

fn reference_now() -> i64 {
    imp_aly::days::parse_iso("2026-10-08T12:00:00Z").unwrap()
}

fn query(fields: &str, from: &str, to: &str) -> Query {
    let mut value = json::parse(fields).unwrap();
    if let Value::Object(object) = &mut value {
        object.insert("app", "myapp");
        object.insert("from", from);
        object.insert("to", to);
    }
    parse_query(&value, reference_now()).unwrap()
}

fn day_queries() -> Vec<Query> {
    QUERIES
        .iter()
        .map(|fields| query(fields, DAYS[0], DAYS[1]))
        .collect()
}

fn without_servers(value: &Value) -> Value {
    let mut copy = value.as_object().unwrap().clone();
    copy.insert("servers", Value::Array(Vec::new()));
    Value::Object(copy)
}

fn period_days() -> Vec<String> {
    let mut out = Vec::new();
    let mut time = day_ms("2026-08-29").unwrap();
    while time <= day_ms("2026-10-04").unwrap() {
        let day = day_of(time);
        if day != "2026-09-09" {
            out.push(day);
        }
        time += DAY_MS;
    }
    out
}

fn reference() -> Value {
    json::parse(&std::fs::read_to_string("tests/fixtures/reference-answers.json").unwrap()).unwrap()
}

#[test]
fn answers_match_the_reference_answers_of_the_javascript_server() {
    let reference = reference();
    let dir = fill(&days(&DAYS), SOURCE, &all);
    let queries = day_queries();
    let expected = reference.get("days").unwrap().as_array().unwrap();
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            json::stringify(&ask(&dir.path, query)),
            json::stringify(expected[index].get("scan").unwrap()),
            "scan {index}"
        );
    }
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            json::stringify(&ask(&dir.path, query)),
            json::stringify(expected[index].get("sealed").unwrap()),
            "sealed {index}"
        );
    }
    let list = period_days();
    let period_dir = fill(&list, SOURCE, &all);
    seal_all(&period_dir.path, SOURCE, &list);
    let queries: Vec<Query> = QUERIES
        .iter()
        .map(|fields| query(fields, "2026-08-28", "2026-10-05"))
        .collect();
    let expected = reference.get("periods").unwrap().as_array().unwrap();
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            json::stringify(&ask(&period_dir.path, query)),
            json::stringify(expected[index].get("days").unwrap()),
            "period days {index}"
        );
    }
    let now = imp_aly::days::parse_iso("2026-10-08T12:00:00Z").unwrap();
    seal_due_periods(&period_dir.path, SOURCE, now, 0, &mut HashSet::new());
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            json::stringify(&ask(&period_dir.path, query)),
            json::stringify(expected[index].get("summaries").unwrap()),
            "period summaries {index}"
        );
    }
}

#[test]
fn summaries_answer_every_query_exactly_like_a_scan() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    let queries = day_queries();
    let scanned: Vec<Value> = queries.iter().map(|query| ask(&dir.path, query)).collect();
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    for (index, query) in queries.iter().enumerate() {
        let result = ask(&dir.path, query);
        let summary_days = result.get("servers").unwrap().as_array().unwrap()[0]
            .get("summaryDays")
            .unwrap()
            .clone();
        assert_eq!(
            summary_days.as_f64(),
            Some(if can_use_summary(query) { 2.0 } else { 0.0 }),
            "{index}"
        );
        assert_eq!(
            without_servers(&result),
            without_servers(&scanned[index]),
            "query {index}"
        );
    }
}

#[test]
fn the_answers_of_two_servers_with_separate_visits_merge_to_the_answer_of_one() {
    let all_dir = fill(&days(&DAYS), SOURCE, &all);
    let even = fill(&days(&DAYS), SOURCE, &|visit| visit % 2 == 0);
    let odd = fill(&days(&DAYS), SOURCE, &|visit| visit % 2 == 1);
    seal_day(&day_path(&even.path, DAYS[0], SOURCE)).unwrap();
    seal_all(&all_dir.path, SOURCE, &days(&DAYS));
    for (index, query) in day_queries().iter().enumerate() {
        let one = finalize_query(
            query,
            &[ServerAnswer {
                server: "all".to_string(),
                answer: answer_of(&all_dir.path, query),
            }],
        );
        let two = finalize_query(
            query,
            &[
                ServerAnswer {
                    server: "even".to_string(),
                    answer: answer_of(&even.path, query),
                },
                ServerAnswer {
                    server: "odd".to_string(),
                    answer: answer_of(&odd.path, query),
                },
            ],
        );
        assert_eq!(
            without_servers(&Value::Object(two)),
            without_servers(&Value::Object(one)),
            "query {index}"
        );
    }
}

fn backup_file(data_dir: &str, by: &str) -> String {
    let path = format!("{data_dir}/backup-{by}.tar.gz");
    let file = File::create(&path).unwrap();
    write_backup(
        data_dir,
        "all",
        by,
        reference_now(),
        imp_aly::records::DEFAULT_SEAL_DELAY_MS,
        file,
    )
    .unwrap();
    path
}

fn restore(data_dir: &str, file: &str) -> Value {
    restore_backup_file(data_dir, file, reference_now(), 0).unwrap()
}

fn count(value: &Value, key: &str) -> usize {
    value.get(key).unwrap().as_array().unwrap().len()
}

#[test]
fn restored_summaries_answer_like_the_full_data_and_other_queries_skip_the_days() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    let file = backup_file(&dir.path, "day");
    let restored_dir = TempDir::new();
    assert_eq!(count(&restore(&restored_dir.path, &file), "restored"), 2);
    for (index, query) in day_queries().iter().enumerate() {
        let full = ask(&dir.path, query);
        let result = ask(&restored_dir.path, query);
        if can_use_summary(query) {
            assert_eq!(result, full, "query {index}");
        } else {
            let skipped: Vec<String> = result
                .get("skippedDays")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    format!(
                        "{} {} {}",
                        entry.get_str("day").unwrap(),
                        entry.get_str("source").unwrap(),
                        entry.get_str("reason").unwrap()
                    )
                })
                .collect();
            assert_eq!(
                skipped,
                DAYS.map(|day| format!("{day} {SOURCE} {SUMMARY_ONLY_PROBLEM}"))
            );
            assert_eq!(result.get("scanned").unwrap().as_f64(), Some(0.0));
        }
    }
    let counted = count_backup(File::open(&file).unwrap()).unwrap();
    assert_eq!((counted.apps, counted.sources, counted.days), (1, 1, 2));
}

#[test]
fn the_backups_of_two_servers_restore_into_a_third_which_answers_like_the_two() {
    let even = fill(&days(&DAYS), SOURCE, &|visit| visit % 2 == 0);
    let odd = fill(&days(&DAYS), OTHER_SOURCE, &|visit| visit % 2 == 1);
    seal_all(&even.path, SOURCE, &days(&DAYS));
    seal_all(&odd.path, OTHER_SOURCE, &days(&DAYS));
    let backups = [
        backup_file(&even.path, "day"),
        backup_file(&odd.path, "day"),
    ];
    let third = TempDir::new();
    for file in &backups {
        assert_eq!(count(&restore(&third.path, file), "restored"), 2);
    }
    let once: Vec<Value> = day_queries()
        .iter()
        .map(|query| ask(&third.path, query))
        .collect();
    for (index, query) in day_queries().iter().enumerate() {
        let two = finalize_query(
            query,
            &[
                ServerAnswer {
                    server: "even".to_string(),
                    answer: answer_of(&even.path, query),
                },
                ServerAnswer {
                    server: "odd".to_string(),
                    answer: answer_of(&odd.path, query),
                },
            ],
        );
        if can_use_summary(query) {
            assert_eq!(
                without_servers(&once[index]),
                without_servers(&Value::Object(two)),
                "query {index}"
            );
        } else {
            assert_eq!(once[index].get("scanned").unwrap().as_f64(), Some(0.0));
        }
    }
    for file in &backups {
        let again = restore(&third.path, file);
        assert_eq!(
            (count(&again, "restored"), count(&again, "skipped")),
            (0, 2)
        );
    }
    let twice: Vec<Value> = day_queries()
        .iter()
        .map(|query| ask(&third.path, query))
        .collect();
    assert_eq!(twice, once);
}

#[test]
fn a_damaged_backup_restores_nothing() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    let file = backup_file(&dir.path, "day");
    let mut bytes = std::fs::read(&file).unwrap();
    let length = bytes.len();
    bytes.truncate(length / 2);
    let broken = format!("{}/broken.tar.gz", dir.path);
    std::fs::write(&broken, &bytes).unwrap();
    let target = TempDir::new();
    let error = restore_backup_file(&target.path, &broken, reference_now(), 0).unwrap_err();
    assert_eq!(error.status, Some(400));
    assert!(error.message.contains("not valid"));
    assert!(!std::path::Path::new(&format!("{}/apps", target.path)).exists());
    std::fs::write(&broken, b"not a backup").unwrap();
    assert!(restore_backup_file(&target.path, &broken, reference_now(), 0).is_err());
}

#[test]
fn a_day_with_late_records_is_scanned() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    let path = day_path(&dir.path, DAYS[0], SOURCE);
    seal_day(&path).unwrap();
    let late = format!(
        r#"["myapp","{}",{{"type":"error","visit":"late","at":{},"page":"/"}}]"#,
        DAYS[0],
        day_ms(DAYS[0]).unwrap()
    );
    apply_segment_text(&dir.path, SOURCE, 2, &format!("{late}\n")).unwrap();
    let query = query(r#"{"measures":["records","visits"]}"#, DAYS[0], DAYS[0]);
    let result = ask(&dir.path, &query);
    let summary_days = |value: &Value| {
        value.get("servers").unwrap().as_array().unwrap()[0]
            .get("summaryDays")
            .unwrap()
            .as_f64()
    };
    assert_eq!(summary_days(&result), Some(0.0));
    assert_eq!(
        result.get("rows").unwrap().as_array().unwrap()[0]
            .get("records")
            .unwrap()
            .as_f64(),
        Some(481.0)
    );
    seal_day(&path).unwrap();
    let again = ask(&dir.path, &query);
    assert_eq!(summary_days(&again), Some(1.0));
    assert_eq!(again.get("rows"), result.get("rows"));
}

#[test]
fn week_and_month_summaries_are_made_once_and_answer_like_the_days() {
    let list = period_days();
    let dir = fill(&list, SOURCE, &all);
    seal_all(&dir.path, SOURCE, &list);
    let now = imp_aly::days::parse_iso("2026-10-08T12:00:00Z").unwrap();
    let queries: Vec<Query> = QUERIES
        .iter()
        .map(|fields| query(fields, "2026-08-28", "2026-10-05"))
        .collect();
    let from_days: Vec<Value> = queries.iter().map(|query| ask(&dir.path, query)).collect();
    let mut checked = HashSet::new();
    let built = seal_due_periods(&dir.path, SOURCE, now, 0, &mut checked);
    assert_eq!(
        built,
        [
            "myapp/weeks/2026-08-24",
            "myapp/months/2026-08",
            "myapp/weeks/2026-08-31",
            "myapp/months/2026-09",
            "myapp/weeks/2026-09-07",
            "myapp/weeks/2026-09-14",
            "myapp/weeks/2026-09-21",
            "myapp/weeks/2026-09-28",
        ]
    );
    assert!(seal_due_periods(&dir.path, SOURCE, now, 0, &mut HashSet::new()).is_empty());
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(ask(&dir.path, query), from_days[index], "query {index}");
    }
    let week_backup = backup_file(&dir.path, "week");
    let month_backup = backup_file(&dir.path, "month");
    let counted = count_backup(File::open(&week_backup).unwrap()).unwrap();
    assert_eq!(counted.weeks, 6);
    let target = TempDir::new();
    let restored = restore(&target.path, &month_backup);
    assert_eq!(count(&restored, "restored"), 2);
    let by_month = query(
        r#"{"groupBy":["month"],"measures":["visits","records"]}"#,
        "2026-08-01",
        "2026-09-30",
    );
    let restored_answer = ask(&target.path, &by_month);
    let full_answer = ask(&dir.path, &by_month);
    assert_eq!(restored_answer.get("rows"), full_answer.get("rows"));
    let by_day = query(r#"{"groupBy":["day"]}"#, "2026-09-01", "2026-09-30");
    let skipped = ask(&target.path, &by_day);
    assert!(
        !skipped
            .get("skippedDays")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_summary_cache_never_gives_the_answer_of_an_old_generation_or_a_removed_folder() {
    let engine = imp_aly::query::QueryEngine::new(usize::MAX, 100);
    let settle = || std::thread::sleep(std::time::Duration::from_millis(150));
    let cached = |dir: &str, query: &Query| {
        let answer = engine.run(dir, query, &|| false).unwrap();
        json::parse(&json::stringify(&answer)).unwrap()
    };
    let dir = fill(&days(&DAYS), SOURCE, &all);
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    settle();
    let queries = day_queries();
    for query in &queries {
        assert_eq!(cached(&dir.path, query), answer_of(&dir.path, query));
    }
    assert!(engine.cached_bytes() > 0);
    for query in &queries {
        assert_eq!(cached(&dir.path, query), answer_of(&dir.path, query));
    }
    let late = format!(
        r#"["myapp","{}",{{"type":"error","visit":"late","at":{},"page":"/"}}]"#,
        DAYS[0],
        day_ms(DAYS[0]).unwrap()
    );
    apply_segment_text(&dir.path, SOURCE, 2, &format!("{late}\n")).unwrap();
    seal_day(&day_path(&dir.path, DAYS[0], SOURCE)).unwrap();
    settle();
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            cached(&dir.path, query),
            answer_of(&dir.path, query),
            "new generation {index}"
        );
    }
    std::fs::remove_dir_all(day_path(&dir.path, DAYS[1], SOURCE)).unwrap();
    settle();
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            cached(&dir.path, query),
            answer_of(&dir.path, query),
            "removed folder {index}"
        );
    }
    let path = day_path(&dir.path, DAYS[0], SOURCE);
    std::fs::remove_dir_all(&path).unwrap();
    let other = fill(&days(&DAYS[..1]), SOURCE, &|visit| visit % 3 == 0);
    std::fs::rename(day_path(&other.path, DAYS[0], SOURCE), &path).unwrap();
    seal_day(&path).unwrap();
    settle();
    for (index, query) in queries.iter().enumerate() {
        assert_eq!(
            cached(&dir.path, query),
            answer_of(&dir.path, query),
            "new folder with the same generation {index}"
        );
    }
}

fn ask_with(engine: &imp_aly::query::QueryEngine, data_dir: &str, query: &Query) -> Value {
    let answer = engine.run(data_dir, query, &|| false).unwrap();
    let answer = json::parse(&json::stringify(&answer)).unwrap();
    Value::Object(finalize_query(
        query,
        &[ServerAnswer {
            server: "local".to_string(),
            answer,
        }],
    ))
}

fn summary_days_of(value: &Value) -> Option<f64> {
    value.get("servers").unwrap().as_array().unwrap()[0]
        .get("summaryDays")
        .unwrap()
        .as_f64()
}

fn fill_live(data_dir: &str, live: &imp_aly::live::LiveDays) {
    let text = fill_text(&days(&DAYS), &all);
    let lines: Vec<&str> = text.lines().collect();
    for (index, part) in lines.chunks(lines.len() / 3 + 1).enumerate() {
        imp_aly::storage::apply_segment(
            data_dir,
            SOURCE,
            index as u64 + 1,
            &format!("{}\n", part.join("\n")),
            &mut std::collections::BTreeMap::new(),
            &mut imp_aly::storage::Counts::default(),
            Some(live),
        )
        .unwrap();
    }
}

fn assert_like_a_scan(engine: &imp_aly::query::QueryEngine, data_dir: &str, label: &str) {
    for (index, query) in day_queries().iter().enumerate() {
        let result = ask_with(engine, data_dir, query);
        assert_eq!(
            summary_days_of(&result),
            Some(if can_use_summary(query) { 2.0 } else { 0.0 }),
            "{label} {index}"
        );
        assert_eq!(
            without_servers(&result),
            without_servers(&ask(data_dir, query)),
            "{label} {index}"
        );
    }
}

#[test]
fn the_running_summary_of_a_raw_day_answers_every_query_exactly_like_a_scan() {
    let dir = TempDir::new();
    let live = std::sync::Arc::new(imp_aly::live::LiveDays::default());
    fill_live(&dir.path, &live);
    let engine = imp_aly::query::QueryEngine::default().with_live(live.clone());
    assert_like_a_scan(&engine, &dir.path, "added");
    let rebuilt = std::sync::Arc::new(imp_aly::live::LiveDays::default());
    for day in DAYS {
        let path = day_path(&dir.path, day, SOURCE);
        let (summary, state) = imp_aly::live::build_from_disk(&path).unwrap();
        rebuilt.put(&path, summary, state);
    }
    let engine = imp_aly::query::QueryEngine::default().with_live(rebuilt);
    assert_like_a_scan(&engine, &dir.path, "rebuilt");
}

#[test]
fn a_running_summary_that_misses_a_stored_part_is_not_used() {
    let dir = TempDir::new();
    let live = std::sync::Arc::new(imp_aly::live::LiveDays::default());
    fill_live(&dir.path, &live);
    let late = format!(
        r#"["myapp","{}",{{"type":"error","visit":"late","at":{},"page":"/","plan":"pro"}}]"#,
        DAYS[0],
        day_ms(DAYS[0]).unwrap()
    );
    apply_segment_text(&dir.path, SOURCE, 10, &format!("{late}\n")).unwrap();
    let engine = imp_aly::query::QueryEngine::default().with_live(live.clone());
    for (index, query) in day_queries().iter().enumerate() {
        let result = ask_with(&engine, &dir.path, query);
        let expected = if can_use_summary(query) { 1.0 } else { 0.0 };
        assert_eq!(summary_days_of(&result), Some(expected), "{index}");
        assert_eq!(
            without_servers(&result),
            without_servers(&ask(&dir.path, query)),
            "{index}"
        );
    }
}

#[test]
fn the_running_summary_of_a_sealed_day_with_late_records_answers_like_a_scan() {
    let dir = fill(&days(&DAYS), SOURCE, &all);
    seal_all(&dir.path, SOURCE, &days(&DAYS));
    let live = std::sync::Arc::new(imp_aly::live::LiveDays::default());
    for (index, day) in DAYS.iter().enumerate() {
        let path = day_path(&dir.path, day, SOURCE);
        let late = format!(
            r#"["myapp","{day}",{{"type":"seen","visit":"v1","at":{},"page":"/","zone":"myapp.zone-9","plan":"team"}}]"#,
            day_ms(day).unwrap()
        );
        let before = imp_aly::live::disk_state(&path).unwrap();
        if index == 0 {
            let (summary, state) = imp_aly::live::build_from_disk(&path).unwrap();
            live.put(&path, summary, state);
        }
        imp_aly::storage::apply_segment(
            &dir.path,
            SOURCE,
            20 + index as u64,
            &format!("{late}\n"),
            &mut std::collections::BTreeMap::new(),
            &mut imp_aly::storage::Counts::default(),
            Some(&live),
        )
        .unwrap();
        if index == 1 {
            assert!(!live.has(&path));
            assert!(before.rows() > 0);
            let (summary, state) = imp_aly::live::build_from_disk(&path).unwrap();
            live.put(&path, summary, state);
        }
    }
    let engine = imp_aly::query::QueryEngine::default().with_live(live);
    assert_like_a_scan(&engine, &dir.path, "late");
}

#[test]
fn a_query_on_several_threads_gives_the_answer_of_one_thread() {
    let list = period_days();
    let dir = fill(&list, SOURCE, &all);
    fill_into(&dir.path, &list[..10], OTHER_SOURCE, &|visit| {
        visit % 2 == 0
    });
    seal_all(&dir.path, SOURCE, &list[..list.len() - 3]);
    let now = imp_aly::days::parse_iso("2026-10-08T12:00:00Z").unwrap();
    seal_due_periods(&dir.path, SOURCE, now, 0, &mut HashSet::new());
    let one = imp_aly::query::QueryEngine::default().with_threads(1);
    let four = imp_aly::query::QueryEngine::default().with_threads(4);
    for (index, fields) in QUERIES.iter().enumerate() {
        let query = query(fields, "2026-08-28", "2026-10-05");
        let answer = |engine: &imp_aly::query::QueryEngine| {
            json::stringify(&engine.run(&dir.path, &query, &|| false).unwrap())
        };
        assert_eq!(answer(&four), answer(&one), "query {index}");
    }
}

#[test]
fn a_month_summary_that_cannot_be_read_gives_way_to_its_weeks_and_days_on_any_number_of_threads() {
    let list = period_days();
    let queries: Vec<Query> = QUERIES
        .iter()
        .map(|fields| query(fields, "2026-08-28", "2026-10-05"))
        .collect();
    for damage in ["removed", "garbage", "truncated"] {
        let dir = fill(&list, SOURCE, &all);
        seal_all(&dir.path, SOURCE, &list);
        let from_days: Vec<Value> = queries.iter().map(|query| ask(&dir.path, query)).collect();
        let now = imp_aly::days::parse_iso("2026-10-08T12:00:00Z").unwrap();
        seal_due_periods(&dir.path, SOURCE, now, 0, &mut HashSet::new());
        let month = imp_aly::periods::period_source_dir(
            &dir.path,
            "myapp",
            imp_aly::days::PeriodKind::Months,
            "2026-09",
            SOURCE,
        );
        let counts = format!("{month}/sealed-1/summary-counts.tsv");
        match damage {
            "removed" => std::fs::remove_file(&counts).unwrap(),
            "garbage" => std::fs::write(&counts, "garbage\n").unwrap(),
            _ => {
                let text = std::fs::read_to_string(&counts).unwrap();
                let kept: Vec<&str> = text.lines().collect();
                std::fs::write(&counts, format!("{}\n", kept[..kept.len() - 1].join("\n")))
                    .unwrap();
            }
        }
        for threads in [1, 4] {
            let engine = imp_aly::query::QueryEngine::default().with_threads(threads);
            for (index, query) in queries.iter().enumerate() {
                let answer = ask_with(&engine, &dir.path, query);
                assert_eq!(
                    answer, from_days[index],
                    "{damage}: query {index} on {threads} threads"
                );
            }
        }
    }
}
