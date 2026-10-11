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
