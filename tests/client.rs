mod support;

use imp_aly::api_client::{ApiTarget, call_server, query_servers};
use imp_aly::args::parse_args;
use imp_aly::console::start_console;
use imp_aly::json::{self, Value};
use imp_aly::static_files::{Files, serve_ui};
use imp_aly::testing::TempDir;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use support::*;

const ANSWER: &str = r#"{"days":["2026-10-01"],"summaryDays":1,"scanned":4,"matched":4,"skippedDays":[],"groups":[{"by":[],"records":4,"visits":2}],"appConfig":"a"}"#;

fn fake_server(kind: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            std::thread::spawn(move || {
                let mut buffer = [0u8; 65_536];
                let _ = stream.read(&mut buffer);
                let (content_type, body) = match kind {
                    "good" => ("application/json", ANSWER.to_string()),
                    "html" => ("text/html", "<html>proxy</html>".to_string()),
                    "wrong" => ("application/json", r#"{"hello":"world"}"#.to_string()),
                    _ => {
                        std::thread::sleep(Duration::from_secs(5));
                        return;
                    }
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    port
}

fn target(name: &str, port: u16) -> ApiTarget {
    ApiTarget {
        label: name.to_string(),
        url: format!("http://127.0.0.1:{port}"),
        auth: Some("api-client-test-key-0123456789".to_string()),
        server: Some(name.to_string()),
        service: false,
    }
}

#[test]
fn a_stalled_server_and_a_reply_that_is_not_an_answer_fail_and_the_others_still_count() {
    let targets: Vec<ApiTarget> = ["good", "html", "wrong", "stalled"]
        .into_iter()
        .map(|kind| target(kind, fake_server(kind)))
        .collect();
    let started = Instant::now();
    let outcome = query_servers(
        &targets,
        &json::parse(r#"{"app":"myapp","from":"2026-10-01"}"#).unwrap(),
        Some(300),
    )
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the query waited for the stalled server"
    );
    assert_eq!(
        json::stringify(outcome.result.get("rows").unwrap()),
        r#"[{"records":4}]"#
    );
    let reason = |name: &str| {
        outcome
            .failed
            .iter()
            .find(|(server, _)| server == name)
            .map(|(_, reason)| reason.clone())
            .unwrap_or_default()
    };
    assert_eq!(outcome.failed.len(), 3);
    assert!(reason("html").contains("not JSON"), "{}", reason("html"));
    assert!(
        reason("wrong").contains("not a query answer"),
        "{}",
        reason("wrong")
    );
    assert!(
        reason("stalled").contains("did not answer in 0.3 s"),
        "{}",
        reason("stalled")
    );
    let error = call_server(&targets[1], "GET", "/apps", None, Some(5_000)).unwrap_err();
    assert!(
        error
            .message
            .contains("answered 200 with a reply that is not JSON")
    );
}

fn parsed(list: &[&str]) -> imp_aly::args::Parsed {
    parse_args(&list.iter().map(|item| item.to_string()).collect::<Vec<_>>()).unwrap()
}

#[test]
fn app_add_uploads_the_file_of_a_build_folder() {
    let server = Server::start(|_| {});
    let dist = TempDir::new();
    let url = format!("http://127.0.0.1:{}", server.admin_port);
    let run = |action: &[&str]| {
        let mut list = vec!["app"];
        list.extend_from_slice(action);
        list.extend_from_slice(&["--url", &url, "-a", KEY]);
        imp_aly::commands::app::app(&parsed(&list))
    };
    let missing = run(&["add", "myapp", &dist.path]).unwrap_err();
    assert!(missing.message.contains("app-analytics.json"), "{missing}");
    std::fs::write(
        dist.join("app-analytics.json"),
        r#"{"pages":["/","/invoices/:id"],"zones":["myapp.send"],"outcomes":[]}"#,
    )
    .unwrap();
    let file = dist.join("app-analytics.json");
    assert!(
        run(&["add", "myapp", &file])
            .unwrap_err()
            .message
            .contains("is not a folder")
    );
    run(&["add", "myapp", &dist.path]).unwrap();
    let shown = server.admin("GET", "/apps/myapp", None);
    assert_eq!(shown.get("appUrl"), Value::Null);
    assert_eq!(shown.text_of("pages"), r#"["/","/invoices/:id"]"#);
    assert!(
        run(&["refresh", "myapp"])
            .unwrap_err()
            .message
            .contains("uploaded build and no appUrl")
    );
}

fn write_ui() -> (TempDir, TempDir) {
    let ui = TempDir::new();
    std::fs::create_dir_all(ui.join("chunks")).unwrap();
    std::fs::write(
        ui.join("index.html"),
        "<!DOCTYPE html><title>console</title>",
    )
    .unwrap();
    std::fs::write(ui.join("chunks/main-1.js"), "export {}").unwrap();
    let outside = TempDir::new();
    std::fs::write(outside.join("secret.txt"), "secret").unwrap();
    (ui, outside)
}

fn raw(port: u16, request: &str) -> Answer {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    parse_response(&bytes)
}

#[test]
fn the_console_answers_only_on_localhost_serves_files_only_and_sets_strict_headers() {
    let (ui, _outside) = write_ui();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let console = runtime
        .block_on(start_console(0, Files::Folder(PathBuf::from(&ui.path))))
        .unwrap();
    let port = console.port;
    let page = raw(
        port,
        &format!("GET /servers HTTP/1.1\r\nhost: localhost:{port}\r\nconnection: close\r\n\r\n"),
    );
    assert_eq!(page.status, 200);
    assert_eq!(page.text, "<!DOCTYPE html><title>console</title>");
    let policy = page.header("content-security-policy").unwrap();
    assert!(policy.contains("script-src 'self'"));
    assert!(policy.contains("connect-src 'self' https: http:"));
    assert_eq!(page.header("x-frame-options"), Some("DENY"));
    let evil = raw(
        port,
        &format!("GET / HTTP/1.1\r\nhost: evil.example:{port}\r\nconnection: close\r\n\r\n"),
    );
    assert_eq!(evil.status, 403);
    let local = raw(
        port,
        &format!("GET / HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n"),
    );
    assert_eq!(local.status, 200);
    let post = raw(
        port,
        &format!(
            "POST / HTTP/1.1\r\nhost: localhost:{port}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        ),
    );
    assert_eq!(post.status, 405);
    let error = runtime
        .block_on(start_console(port, Files::Folder(PathBuf::from(&ui.path))))
        .err()
        .unwrap();
    assert!(error.message.contains("is in use"));
    let empty = TempDir::new();
    let missing = runtime
        .block_on(start_console(0, Files::Folder(PathBuf::from(&empty.path))))
        .err()
        .unwrap();
    assert!(missing.message.contains("console page is missing"));
    runtime.block_on(console.shutdown());
}

#[test]
fn the_page_files_are_served_with_a_fallback_for_routes_and_never_outside_the_folder() {
    let (ui, _outside) = write_ui();
    let files = Files::Folder(PathBuf::from(&ui.path));
    let index = serve_ui(&files, "/overview");
    assert_eq!(index.get_header("cache-control"), Some("no-cache"));
    let chunk = serve_ui(&files, "/chunks/main-1.js");
    assert_eq!(
        chunk.get_header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert!(
        chunk
            .get_header("cache-control")
            .unwrap()
            .contains("immutable")
    );
    for path in [
        "/chunks/main-2.js",
        "/missing.js",
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/.git/config",
    ] {
        assert_eq!(serve_ui(&files, path).status, 404, "{path}");
    }
}

#[test]
fn a_backup_of_one_server_restores_into_another() {
    let source_dir = TempDir::new();
    fill_into(&source_dir.path, &days(&DAYS), SOURCE, &all);
    seal_all(&source_dir.path, SOURCE, &days(&DAYS));
    let source = Server::start_in(Some(source_dir.path.clone()), |_| {});
    let target = Server::start(|_| {});
    assert_eq!(
        send(source.admin_port, "GET", "/backup", None, &[]).status,
        401
    );
    assert_eq!(
        source.admin("GET", "/backup?last=yesterday", None).status,
        400
    );
    assert_eq!(source.admin("GET", "/backup?app=myapp", None).status, 400);
    let path = "/backup?last=all&by=day";
    let auth = format!("Bearer {}", token(KEY, "GET", path, None));
    let bytes = raw_bytes(
        source.admin_port,
        "GET",
        path,
        None,
        &[("authorization", &auth)],
    );
    let end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
    assert!(head.contains("content-type: application/gzip"));
    let backup = dechunk(&bytes[end + 4..]);
    let restore = |body: &[u8], signed: &[u8]| {
        let auth = format!("Bearer {}", token(KEY, "POST", "/restore", Some(signed)));
        parse_response(&raw_bytes(
            target.admin_port,
            "POST",
            "/restore",
            Some(body),
            &[("authorization", &auth)],
        ))
    };
    let forged = restore(&backup, b"another body");
    assert_eq!(forged.status, 401);
    assert!(
        forged
            .get("error")
            .as_str()
            .unwrap()
            .contains("does not match")
    );
    let posted = restore(&backup, &backup);
    assert_eq!(posted.status, 200);
    assert_eq!(posted.get("restored").as_array().unwrap().len(), 2);
    assert_eq!(
        restore(&backup, &backup)
            .get("skipped")
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let broken = restore(b"not a backup", b"not a backup");
    assert_eq!(broken.status, 400);
    assert!(broken.get("error").as_str().unwrap().contains("not valid"));
    let query = format!(
        r#"{{"app":"myapp","from":"{}","to":"{}","groupBy":["page"]}}"#,
        DAYS[0], DAYS[1]
    );
    let expected = source.admin("POST", "/query", Some(&query));
    let answered = target.admin("POST", "/query", Some(&query));
    assert_eq!(answered.text_of("groups"), expected.text_of("groups"));
    assert_eq!(answered.text_of("summaryDays"), "2");
    drop(source);
    let _ = source_dir;
}

#[test]
fn the_cli_adds_up_the_answers_like_the_console() {
    let text = std::fs::read_to_string("console/test/merge-cases.json").unwrap();
    let cases = json::parse(&text).unwrap();
    let now = imp_aly::days::parse_iso("2026-10-10T12:00:00Z").unwrap();
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let query = imp_aly::query_core::parse_query(case.get("query").unwrap(), now).unwrap();
        let answers: Vec<imp_aly::query_core::ServerAnswer> = case
            .get("answers")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| imp_aly::query_core::ServerAnswer {
                server: entry.get_str("server").unwrap().to_string(),
                answer: entry.get("answer").unwrap().clone(),
            })
            .collect();
        let result = imp_aly::query_core::finalize_query(&query, &answers);
        assert_eq!(
            json::stringify(&Value::Object(result)),
            json::stringify(case.get("result").unwrap()),
            "case {index}"
        );
    }
}
