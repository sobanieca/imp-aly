mod support;

use imp_aly::json::{self, Value};
use imp_aly::rate_limit::Window;
use imp_aly::testing::TempDir;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};
use support::*;

fn rejections(answer: &Answer) -> String {
    answer.text_of("rejections")
}

#[test]
fn collects_valid_records_and_answers_queries() {
    let server = Server::start(|_| {});
    assert_eq!(
        send(server.admin_port, "GET", "/apps", None, &[]).status,
        401
    );
    let body = format!(r#"{{"appUrl":"{APP_URL}","segments":["plan"]}}"#);
    let added = server.admin("PUT", "/apps/myapp", Some(&body));
    assert_eq!(added.status, 200);
    assert_eq!(added.get("pages").as_array().unwrap().len(), 3);
    assert_eq!(added.text_of("zones"), r#"["myapp.list","myapp.send"]"#);
    let batch = format!(
        "[{},{},{},{}]",
        record(r#""type":"page","plan":"pro""#),
        record(r#""type":"seen","zone":"myapp.send""#),
        record(r#""type":"used","zone":null"#),
        record(r#""type":"page","page":"/admin""#).replace(r#""page":"/invoices/:id","#, ""),
    );
    let posted = server.call("POST", "/collect/myapp", Some(&batch), &[]);
    assert_eq!(posted.status, 202);
    assert_eq!(posted.text, r#"{"accepted":3,"rejected":1}"#);
    assert_eq!(posted.header("access-control-allow-origin"), None);
    assert_eq!(added.text_of("origins"), r#"["https://myapp.example"]"#);
    let single = server.call(
        "POST",
        "/collect/myapp",
        Some(&record(r#""type":"error""#)),
        &[("content-type", "text/plain;charset=UTF-8")],
    );
    assert_eq!(single.text, r#"{"accepted":1,"rejected":0}"#);
    let query = r#"{"app":"myapp","groupBy":["type"],"measures":["records","visits"]}"#;
    server.wait_for(|| server.matched(query) == 4);
    let answer = server.admin("POST", "/query", Some(query));
    let mut groups: Vec<String> = answer
        .get("groups")
        .as_array()
        .unwrap()
        .iter()
        .map(|group| {
            format!(
                "{}:{}",
                group.get("by").unwrap().as_array().unwrap()[0]
                    .as_str()
                    .unwrap(),
                json::stringify(group.get("records").unwrap())
            )
        })
        .collect();
    groups.sort();
    assert_eq!(groups, ["error:1", "page:1", "seen:1", "used:1"]);
    let plans = server.admin(
        "POST",
        "/query",
        Some(r#"{"app":"myapp","where":{"plan":"pro"}}"#),
    );
    assert_eq!(plans.text_of("groups"), r#"[{"by":[],"records":1}]"#);
    assert_eq!(plans.get("appConfig").as_str().unwrap().len(), 16);
    let apps = server.admin("GET", "/apps", None);
    assert_eq!(apps.text_of("apps.0.accepted"), "4");
    assert_eq!(
        apps.text_of("apps.0.rejections"),
        r#"{"page is not in the pages of app-analytics.json":1}"#
    );
    assert_eq!(server.admin("GET", "/status", None).status, 200);
}

#[test]
fn a_server_keeps_its_source_id_over_a_restart() {
    let first = Server::start(|_| {});
    let source = first
        .admin("GET", "/status", None)
        .get("source")
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(source.len(), 16);
    let data_dir = first.stop();
    let second = Server::start_in(Some(data_dir.clone()), |_| {});
    assert_eq!(
        second.admin("GET", "/status", None).get("source").as_str(),
        Some(source.as_str())
    );
    drop(second);
    let _ = std::fs::remove_dir_all(data_dir);
}

#[test]
fn a_removed_app_keeps_its_records_and_a_new_registration_brings_them_back() {
    let server = Server::start(|_| {});
    let body = format!(r#"{{"appUrl":"{APP_URL}","segments":["plan"]}}"#);
    server.admin("PUT", "/apps/myapp", Some(&body));
    server.call(
        "POST",
        "/collect/myapp",
        Some(&format!(
            "[{},{}]",
            record(r#""type":"page","plan":"pro""#),
            record(r#""type":"page","plan":"free""#)
        )),
        &[],
    );
    let count = || {
        server
            .admin("POST", "/query", Some(r#"{"app":"myapp"}"#))
            .get("groups.0.records")
            .as_f64()
            .unwrap_or(0.0)
    };
    server.wait_for(|| count() == 2.0);
    assert_eq!(
        server.admin("DELETE", "/apps/myapp", None).text,
        r#"{"removed":"myapp"}"#
    );
    assert_eq!(server.admin("GET", "/apps", None).text, r#"{"apps":[]}"#);
    assert_eq!(
        server
            .call(
                "POST",
                "/collect/myapp",
                Some(&format!("[{}]", record(r#""type":"page""#))),
                &[]
            )
            .status,
        404
    );
    assert_eq!(count(), 2.0);
    server.admin("PUT", "/apps/myapp", Some(&body));
    let plans = server.admin(
        "POST",
        "/query",
        Some(r#"{"app":"myapp","where":{"plan":"pro"}}"#),
    );
    assert_eq!(plans.text_of("groups"), r#"[{"by":[],"records":1}]"#);
}

#[test]
fn rejects_malformed_and_oversized_requests() {
    let server = Server::start(|_| {});
    server.register();
    assert_eq!(
        server
            .call("POST", "/collect/other", Some("[]"), &[])
            .status,
        404
    );
    assert_eq!(
        server
            .call("POST", "/collect/myapp", Some("{not json"), &[])
            .status,
        400
    );
    assert_eq!(
        server
            .call("POST", "/collect/myapp", Some(&"x".repeat(70_000)), &[])
            .status,
        413
    );
    let many: Vec<String> = (0..150).map(|_| record(r#""type":"error""#)).collect();
    assert_eq!(
        server
            .call(
                "POST",
                "/collect/myapp",
                Some(&format!("[{}]", many.join(","))),
                &[]
            )
            .text,
        r#"{"accepted":150,"rejected":0}"#
    );
    assert_eq!(server.call("GET", "/collect/myapp", None, &[]).status, 405);
    assert_eq!(server.call("GET", "/nothing", None, &[]).status, 404);
    assert_eq!(
        server
            .admin("PUT", "/apps/Bad_Name", Some(&build_body()))
            .status,
        400
    );
    server.host(
        "https://no-slash.example/",
        build_text(Some(r#"["no-slash"]"#), None, None),
    );
    server.host("https://not-json.example/", "{".to_string());
    for app_url in ["https://no-slash.example/", "https://not-json.example/"] {
        let body = format!(r#"{{"appUrl":"{app_url}"}}"#);
        assert_eq!(
            server.admin("PUT", "/apps/x", Some(&body)).status,
            422,
            "{app_url}"
        );
    }
    let upload = format!(
        r#"{{"appUrl":"{APP_URL}","build":{}}}"#,
        json::quote(&build_text(None, None, None))
    );
    let unknown = server.admin("PUT", "/apps/x", Some(&upload));
    assert_eq!(unknown.status, 400);
    assert_eq!(unknown.get("error").as_str(), Some("unknown fields: build"));
    assert_eq!(
        server
            .admin("PUT", "/apps/x", Some(r#"{"segments":[]}"#))
            .status,
        400
    );
    assert_eq!(
        server
            .admin("PUT", "/apps/x", Some(r#"{"appUrl":"myapp.example"}"#))
            .status,
        400
    );
    assert_eq!(
        server
            .admin(
                "PUT",
                "/apps/x",
                Some(r#"{"appUrl":"https://nowhere.example/"}"#)
            )
            .status,
        422
    );
    for segment in ["page", "Page", "week", "constructor", "toString"] {
        let body = format!(r#"{{"appUrl":"{APP_URL}","segments":["{segment}"]}}"#);
        assert_eq!(
            server.admin("PUT", "/apps/x", Some(&body)).status,
            400,
            "{segment}"
        );
    }
    let twice = format!(r#"{{"appUrl":"{APP_URL}","segments":["plan","Plan"]}}"#);
    assert_eq!(server.admin("PUT", "/apps/x", Some(&twice)).status, 400);
    assert_eq!(
        server
            .admin(
                "POST",
                "/query",
                Some(r#"{"app":"myapp","measures":["nope"]}"#)
            )
            .status,
        400
    );
    let token = token(KEY, "GET", "/apps", None);
    let auth = format!("Bearer {token}");
    let first = send(
        server.admin_port,
        "GET",
        "/apps",
        None,
        &[("authorization", &auth)],
    );
    let replay = send(
        server.admin_port,
        "GET",
        "/apps",
        None,
        &[("authorization", &auth)],
    );
    assert_eq!((first.status, replay.status), (200, 401));
}

#[test]
fn a_new_key_works_at_once_and_the_old_key_stops() {
    let server = Server::start(|_| {});
    let status = |key: &str| {
        let auth = format!("Bearer {}", token(key, "GET", "/status", None));
        send(
            server.admin_port,
            "GET",
            "/status",
            None,
            &[("authorization", &auth)],
        )
        .status
    };
    assert_eq!(status(KEY), 200);
    let running = server.server.as_ref().unwrap();
    running.set_key("next-key-0123456789").unwrap();
    assert_eq!(status(KEY), 401);
    assert_eq!(status("next-key-0123456789"), 200);
    assert_eq!(
        running.set_key("").unwrap_err().message,
        "the server needs a key"
    );
    assert_eq!(status("next-key-0123456789"), 200);
}

#[test]
fn answers_a_cors_preflight_and_registers_an_app_from_a_url() {
    let server = Server::start(|_| {});
    let preflight = |origin: &str| {
        server.call(
            "OPTIONS",
            "/collect/myapp",
            None,
            &[
                ("origin", origin),
                ("access-control-request-method", "POST"),
            ],
        )
    };
    assert_eq!(preflight("https://myapp.example").status, 404);
    let added = server.admin(
        "PUT",
        "/apps/myapp",
        Some(r#"{"appUrl":"https://myapp.example"}"#),
    );
    assert_eq!(added.get("appUrl").as_str(), Some(APP_URL));
    assert_eq!(added.text_of("origins"), r#"["https://myapp.example"]"#);
    assert_eq!(added.text_of("zones"), r#"["myapp.list","myapp.send"]"#);
    assert_eq!(*server.fetched.lock().unwrap(), [BUILD_URL]);
    let allowed = preflight("https://myapp.example");
    assert_eq!(allowed.status, 204);
    assert_eq!(allowed.header("access-control-allow-methods"), Some("POST"));
    assert_eq!(
        allowed.header("access-control-allow-origin"),
        Some("https://myapp.example")
    );
    assert_eq!(preflight("https://other.example").status, 403);
    assert_eq!(
        server
            .admin("POST", "/apps/myapp/refresh", None)
            .get("buildError"),
        Value::Null
    );
    assert_eq!(server.fetched.lock().unwrap().len(), 2);
    assert_eq!(server.admin("DELETE", "/apps/myapp", None).status, 200);
}

#[test]
fn a_failed_refresh_keeps_the_last_build_file_and_records_the_error() {
    let server = Server::start(|_| {});
    server.admin(
        "PUT",
        "/apps/myapp",
        Some(&format!(r#"{{"appUrl":"{APP_URL}"}}"#)),
    );
    server.files.lock().unwrap().remove(BUILD_URL);
    let failed = server.admin("POST", "/apps/myapp/refresh", None);
    assert_eq!(
        failed.get("buildError").as_str(),
        Some(format!("GET {BUILD_URL} answered 404").as_str())
    );
    assert_eq!(failed.text_of("zones"), r#"["myapp.list","myapp.send"]"#);
    server.files.lock().unwrap().insert(
        BUILD_URL.to_string(),
        build_text(
            None,
            Some(r#"["myapp.new"]"#),
            Some(r#"["myapp.sent","bad line"]"#),
        ),
    );
    let bad = server.admin("POST", "/apps/myapp/refresh", None);
    assert_eq!(
        bad.get("buildError").as_str(),
        Some(
            "app-analytics.json outcomes[1] \"bad line\" is not an outcome name - a namespaced name, like myapp.sent"
        )
    );
    let posted = server.call(
        "POST",
        "/collect/myapp",
        Some(&format!(
            "[{},{}]",
            record(r#""type":"seen","zone":"myapp.send""#),
            record(r#""type":"seen","zone":"myapp.new""#)
        )),
        &[],
    );
    assert_eq!(posted.text, r#"{"accepted":1,"rejected":1}"#);
    server.files.lock().unwrap().insert(
        BUILD_URL.to_string(),
        build_text(None, Some(r#"["myapp.new"]"#), Some("[]")),
    );
    let fixed = server.admin("POST", "/apps/myapp/refresh", None);
    assert_eq!(fixed.get("buildError"), Value::Null);
    assert_eq!(fixed.text_of("zones"), r#"["myapp.new"]"#);
}

#[test]
fn rejects_the_zones_and_outcomes_that_are_not_in_the_build_file() {
    let server = Server::start(|_| {});
    server.register();
    let batch = [
        record(r#""type":"seen","zone":"myapp.send""#),
        record(r#""type":"used","zone":"myapp.list""#),
        record(r#""type":"used","zone":null"#),
        record(r#""type":"outcome","name":"myapp.sent""#),
        record(r#""type":"seen","zone":"myapp.forged""#),
        record(r#""type":"used","zone":"myapp.forged""#),
        record(r#""type":"outcome","name":"myapp.forged""#),
    ];
    let posted = server.call(
        "POST",
        "/collect/myapp",
        Some(&format!("[{}]", batch.join(","))),
        &[],
    );
    assert_eq!(posted.text, r#"{"accepted":4,"rejected":3}"#);
    assert_eq!(
        rejections(&server.admin("GET", "/apps/myapp", None)),
        r#"{"zone is not in the zones of app-analytics.json":2,"name is not in the outcomes of app-analytics.json":1}"#
    );
}

#[test]
fn the_public_port_and_the_admin_port_serve_separate_endpoints() {
    let server = Server::start(|_| {});
    server.register();
    let auth = format!("Bearer {}", token(KEY, "GET", "/status", None));
    let on_public = server.call("GET", "/status", None, &[("authorization", &auth)]);
    assert_eq!(on_public.status, 404);
    assert_eq!(
        send(server.admin_port, "POST", "/collect/myapp", Some("[]"), &[]).status,
        404
    );
    let posted = server.call(
        "POST",
        "/collect/myapp",
        Some(&format!("[{}]", record(r#""type":"error""#))),
        &[],
    );
    assert_eq!(posted.status, 202);
    let status = server.admin("GET", "/status", None);
    assert_eq!(
        status.text_of("activeRequests"),
        r#"{"public":0,"admin":1}"#
    );
    for answer in [&on_public, &posted, &status] {
        assert_eq!(answer.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(
            answer.header("content-security-policy"),
            Some("default-src 'none'; frame-ancestors 'none'")
        );
    }
    let root = server.call("GET", "/", None, &[]);
    assert_eq!(root.text, format!("imp-aly {}\n", imp_aly::VERSION));
}

#[test]
fn rejects_the_records_of_a_bot_and_of_a_prerendered_page() {
    let server = Server::start(|_| {});
    server.register();
    let batch = format!(
        "[{},{}]",
        record(r#""type":"page""#),
        record(r#""type":"error""#)
    );
    let bot = server.call(
        "POST",
        "/collect/myapp",
        Some(&batch),
        &[(
            "user-agent",
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        )],
    );
    assert_eq!(bot.status, 202);
    assert_eq!(bot.text, r#"{"accepted":0,"rejected":2}"#);
    let prerender = server.call(
        "POST",
        "/collect/myapp",
        Some(&batch),
        &[("sec-purpose", "prefetch;prerender")],
    );
    assert_eq!(prerender.text, r#"{"accepted":0,"rejected":2}"#);
    assert_eq!(
        server
            .call("POST", "/collect/myapp", Some(&batch), &[])
            .text,
        r#"{"accepted":2,"rejected":0}"#
    );
    assert_eq!(
        rejections(&server.admin("GET", "/apps/myapp", None)),
        r#"{"the user agent is a bot":2,"the browser prerendered the page":2}"#
    );
}

#[test]
fn each_app_accepts_records_only_from_its_origins() {
    let server = Server::start(|_| {});
    server.register();
    server.host("https://other.example/", build_text(None, None, None));
    let other_body = r#"{"appUrl":"https://other.example/","origins":["https://other.example","http://localhost:5173"]}"#;
    let other_app = server.admin("PUT", "/apps/other", Some(other_body));
    assert_eq!(
        other_app.text_of("origins"),
        r#"["http://localhost:5173","https://other.example"]"#
    );
    let batch = format!("[{}]", record(r#""type":"error""#));
    let post = |app: &str, origin: Option<&str>| {
        let headers: Vec<(&str, &str)> =
            origin.map(|value| ("origin", value)).into_iter().collect();
        server.call("POST", &format!("/collect/{app}"), Some(&batch), &headers)
    };
    let allowed = post("myapp", Some("https://myapp.example"));
    assert_eq!(allowed.status, 202);
    assert_eq!(
        allowed.header("access-control-allow-origin"),
        Some("https://myapp.example")
    );
    assert_eq!(allowed.header("vary"), Some("origin"));
    let other = post("myapp", Some("https://other.example"));
    assert_eq!(other.status, 403);
    assert_eq!(other.header("access-control-allow-origin"), None);
    assert_eq!(post("other", Some("https://other.example")).status, 202);
    assert_eq!(post("other", Some("http://localhost:5173")).status, 202);
    assert_eq!(post("other", Some("https://myapp.example")).status, 403);
    assert_eq!(post("myapp", Some("null")).status, 403);
    assert_eq!(post("missing", Some("https://myapp.example")).status, 404);
    let preflight = server.call(
        "OPTIONS",
        "/collect/myapp",
        None,
        &[
            ("origin", "https://other.example"),
            ("access-control-request-method", "POST"),
        ],
    );
    assert_eq!(preflight.status, 403);
    let direct = post("myapp", None);
    assert_eq!(direct.status, 202);
    assert_eq!(direct.header("access-control-allow-origin"), None);
}

#[test]
fn an_app_needs_valid_origins() {
    let server = Server::start(|_| {});
    let put = |body: String| server.admin("PUT", "/apps/x", Some(&body));
    for origins in [
        r#"[]"#,
        r#""https://myapp.example""#,
        r#"["https://myapp.example/"]"#,
        r#"["myapp.example"]"#,
        r#"[1]"#,
    ] {
        assert_eq!(
            put(format!(r#"{{"appUrl":"{APP_URL}","origins":{origins}}}"#)).status,
            400,
            "{origins}"
        );
    }
    let many: Vec<String> = (0..33)
        .map(|index| format!(r#""https://a{index}.example""#))
        .collect();
    assert_eq!(
        put(format!(
            r#"{{"appUrl":"{APP_URL}","origins":[{}]}}"#,
            many.join(",")
        ))
        .status,
        400
    );
    assert_eq!(
        put(format!(
            r#"{{"appUrl":"{APP_URL}","origins":["https://myapp.example/"]}}"#
        ))
        .status,
        400
    );
    assert!(server.fetched.lock().unwrap().is_empty());
    let given = put(format!(
        r#"{{"appUrl":"{APP_URL}","origins":["https://www.myapp.example"]}}"#
    ));
    assert_eq!(given.text_of("origins"), r#"["https://www.myapp.example"]"#);
}

fn window(name: &str, ms: u64, limit: u64) -> Window {
    Window {
        name: name.to_string(),
        ms,
        limit,
    }
}

#[test]
fn drops_requests_of_an_address_over_the_limit() {
    let server = Server::start(|options| options.limits = vec![window("5s", 5_000, 10)]);
    server.register();
    let batch: Vec<String> = (0..5).map(|_| record(r#""type":"error""#)).collect();
    assert_eq!(
        server
            .call("POST", "/collect/other-ip", Some("[]"), &[])
            .status,
        404
    );
    assert_eq!(
        server
            .call(
                "POST",
                "/collect/myapp",
                Some(&format!("[{}]", batch[1..].join(","))),
                &[]
            )
            .status,
        202
    );
    assert_eq!(
        server
            .call(
                "POST",
                "/collect/myapp",
                Some(&format!("[{}]", batch.join(","))),
                &[]
            )
            .status,
        429
    );
    let blocked = server.call(
        "POST",
        "/collect/myapp",
        Some(&format!("[{}]", batch.join(","))),
        &[],
    );
    assert_eq!(blocked.status, 429);
    assert_eq!(blocked.header("vary"), Some("origin"));
}

#[test]
fn a_batch_above_the_smallest_limit_fails_and_a_refused_batch_costs_one_request() {
    let server = Server::start(|options| {
        options.limits = vec![window("5s", 5_000, 10), window("1m", 60_000, 50)];
    });
    server.register();
    let batch = |count: usize| {
        format!(
            "[{}]",
            (0..count)
                .map(|_| record(r#""type":"error""#))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let large = server.call("POST", "/collect/myapp", Some(&batch(11)), &[]);
    assert_eq!(large.status, 413);
    assert_eq!(
        large.get("error").as_str(),
        Some("a request holds at most 10 records")
    );
    assert_eq!(
        server
            .call("POST", "/collect/myapp", Some(&batch(5)), &[])
            .status,
        202
    );
    assert_eq!(
        server
            .call("POST", "/collect/myapp", Some(&batch(5)), &[])
            .status,
        429
    );
    assert_eq!(
        server
            .call("POST", "/collect/myapp", Some(&batch(1)), &[])
            .status,
        202
    );
}

fn open_slow_post(port: u16, path: &str, length: usize) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nhost: x\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n"
    )
    .unwrap();
    stream
}

fn answered(stream: &TcpStream) -> bool {
    let mut byte = [0u8; 1];
    stream.set_nonblocking(true).unwrap();
    let peeked = stream.peek(&mut byte);
    stream.set_nonblocking(false).unwrap();
    matches!(peeked, Ok(count) if count > 0)
}

fn finish(mut stream: TcpStream, body: &str) -> Answer {
    stream.write_all(body.as_bytes()).unwrap();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    parse_response(&response)
}

#[test]
fn answers_503_above_the_requests_in_progress() {
    let server = Server::start(|options| options.max_requests = 1);
    server.register();
    let body = format!("[{}]", record(r#""type":"error""#));
    let mut slow = open_slow_post(server.port, "/collect/myapp", body.len());
    server.wait_for(|| {
        if answered(&slow) {
            slow = open_slow_post(server.port, "/collect/myapp", body.len());
        }
        server.call("GET", "/", None, &[]).status == 503
    });
    let busy = server.call("POST", "/collect/myapp", Some(&body), &[]);
    assert_eq!(busy.status, 503);
    assert_eq!(busy.header("retry-after"), Some("5"));
    assert_eq!(busy.header("vary"), Some("origin"));
    assert_eq!(finish(slow, &body).status, 202);
    assert_eq!(server.call("GET", "/", None, &[]).status, 200);
}

#[test]
fn one_address_holds_only_its_share_of_the_requests_in_progress() {
    let server = Server::start(|options| {
        options.max_requests = 8;
        options.max_client_requests = Some(2);
    });
    server.register();
    let body = format!("[{}]", record(r#""type":"error""#));
    let open = || open_slow_post(server.port, "/collect/myapp", body.len());
    let mut first = open();
    let mut second = open();
    server.wait_for(|| {
        if answered(&first) {
            first = open();
        }
        if answered(&second) {
            second = open();
        }
        server.call("GET", "/", None, &[]).status == 429
    });
    let refused = server.call("POST", "/collect/myapp", Some(&body), &[]);
    assert_eq!(refused.status, 429);
    assert_eq!(
        refused.get("error").as_str(),
        Some("too many requests in progress from this address")
    );
    assert_eq!(refused.header("retry-after"), Some("5"));
    assert_eq!(finish(first, &body).status, 202);
    assert_eq!(finish(second, &body).status, 202);
    assert_eq!(server.call("GET", "/", None, &[]).status, 200);
}

#[test]
fn a_collect_body_that_is_too_slow_gets_408_and_frees_its_place() {
    let server = Server::start(|options| options.collect_timeout_ms = 150);
    server.register();
    let mut slow = open_slow_post(server.port, "/collect/myapp", 100);
    slow.write_all(b"[").unwrap();
    let mut response = Vec::new();
    let _ = slow.read_to_end(&mut response);
    assert_eq!(parse_response(&response).status, 408);
    assert_eq!(
        server
            .call(
                "POST",
                "/collect/myapp",
                Some(&format!("[{}]", record(r#""type":"error""#))),
                &[]
            )
            .status,
        202
    );
    assert_eq!(
        server
            .admin("GET", "/status", None)
            .text_of("activeRequests"),
        r#"{"public":0,"admin":1}"#
    );
}

#[test]
fn a_restore_upload_that_stops_sending_gets_408_and_leaves_no_file() {
    let server = Server::start(|options| options.restore_idle_ms = 150);
    let token = token(KEY, "POST", "/restore", Some(b"never sent"));
    let mut stream = TcpStream::connect(("127.0.0.1", server.admin_port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    write!(
        stream,
        "POST /restore HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {token}\r\ncontent-length: 10\r\n\r\nhalf"
    )
    .unwrap();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let answer = parse_response(&response);
    assert_eq!(answer.status, 408);
    assert!(
        answer
            .get("error")
            .as_str()
            .unwrap()
            .contains("no bytes for 0.15 s")
    );
    let left: Vec<_> = std::fs::read_dir(format!("{}/restore", server.data_dir))
        .unwrap()
        .collect();
    assert!(left.is_empty());
}

#[test]
fn a_second_server_cannot_take_a_port_that_a_server_uses() {
    let first = Server::start(|_| {});
    let dir = TempDir::new();
    let mut options = options(&dir.path);
    options.port = first.port;
    let error = first
        .runtime
        .block_on(imp_aly::server::start_server(options))
        .err()
        .unwrap();
    assert!(error.message.contains("is in use"), "{error}");
}

#[test]
fn the_registry_and_the_data_survive_a_restart() {
    let first = Server::start(|_| {});
    first.register();
    first.call(
        "POST",
        "/collect/myapp",
        Some(&format!("[{}]", record(r#""type":"error""#))),
        &[],
    );
    let data_dir = first.stop();
    let second = Server::start_in(Some(data_dir.clone()), |_| {});
    let apps = second.admin("GET", "/apps", None);
    assert_eq!(apps.text_of("apps.0.name"), "\"myapp\"");
    assert_eq!(
        apps.text_of("apps.0.zones"),
        r#"["myapp.list","myapp.send"]"#
    );
    assert_eq!(
        second
            .call(
                "POST",
                "/collect/myapp",
                Some(&format!("[{}]", record(r#""type":"error""#))),
                &[]
            )
            .status,
        202
    );
    second.wait_for(|| second.matched(r#"{"app":"myapp"}"#) == 2);
    drop(second);
    let _ = std::fs::remove_dir_all(data_dir);
}

#[test]
fn a_second_server_on_the_same_data_folder_fails() {
    let first = Server::start(|_| {});
    let error = first
        .runtime
        .block_on(imp_aly::server::start_server(options(&first.data_dir)))
        .err()
        .unwrap();
    assert!(error.message.contains("already uses the data folder"));
}

#[test]
fn a_record_goes_to_the_utc_day_of_its_at() {
    let server = Server::start(|_| {});
    server.register();
    let now = now();
    let earlier = now - 50 * 60_000;
    let later = now + 50 * 60_000;
    let at = |value: i64| format!(r#"{{"type":"error","visit":"v","at":{value},"page":"/"}}"#);
    let posted = server.call(
        "POST",
        "/collect/myapp",
        Some(&format!(
            "[{},{},{}]",
            at(earlier),
            at(later),
            at(now - 2 * 3_600_000)
        )),
        &[],
    );
    assert_eq!(posted.text, r#"{"accepted":2,"rejected":1}"#);
    let (from, to) = (imp_aly::days::day_of(earlier), imp_aly::days::day_of(later));
    let query = format!(r#"{{"app":"myapp","from":"{from}","to":"{to}","groupBy":["day"]}}"#);
    server.wait_for(|| server.matched(&query) == 2);
    for day in [&from, &to] {
        assert!(std::path::Path::new(&format!("{}/apps/myapp/{day}", server.data_dir)).exists());
    }
}

#[test]
fn a_token_works_only_for_its_method_path_and_body() {
    let server = Server::start(|_| {});
    server.register();
    let query = r#"{"app":"myapp"}"#;
    assert_eq!(server.admin("POST", "/query", Some(query)).status, 200);
    let other_path = server.admin_signed("GET", "/apps", None, "GET", "/status", None);
    assert_eq!(other_path.status, 401);
    assert!(
        other_path
            .get("error")
            .as_str()
            .unwrap()
            .contains("another request")
    );
    assert_eq!(
        server
            .admin_signed("DELETE", "/apps/myapp", None, "GET", "/apps/myapp", None)
            .status,
        401
    );
    let other_body = server.admin_signed(
        "POST",
        "/query",
        Some(r#"{"app":"other"}"#),
        "POST",
        "/query",
        Some(query),
    );
    assert_eq!(other_body.status, 401);
    assert!(
        other_body
            .get("error")
            .as_str()
            .unwrap()
            .contains("does not match")
    );
    assert_eq!(
        server
            .admin_signed("GET", "/status", None, "GET", "/status", Some(query))
            .status,
        401
    );
    assert_eq!(
        server
            .admin_signed(
                "GET",
                "/backup?by=week",
                None,
                "GET",
                "/backup?by=month",
                None
            )
            .status,
        401
    );
    assert_eq!(server.admin("GET", "/apps/myapp", None).status, 200);
}

#[test]
fn the_admin_port_lets_a_page_of_any_origin_call_it_with_a_signed_token() {
    let server = Server::start(|_| {});
    let preflight = send(
        server.admin_port,
        "OPTIONS",
        "/query",
        None,
        &[
            ("origin", "https://console.example"),
            ("access-control-request-method", "POST"),
            (
                "access-control-request-headers",
                "authorization, content-type",
            ),
        ],
    );
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.header("access-control-allow-origin"), Some("*"));
    assert!(
        preflight
            .header("access-control-allow-headers")
            .unwrap()
            .contains("authorization")
    );
    assert!(
        preflight
            .header("access-control-allow-methods")
            .unwrap()
            .contains("DELETE")
    );
    let status = server.admin("GET", "/status", None);
    assert_eq!(status.header("access-control-allow-origin"), Some("*"));
    let refused = send(server.admin_port, "GET", "/apps", None, &[]);
    assert_eq!(refused.status, 401);
    assert_eq!(refused.header("access-control-allow-origin"), Some("*"));
}

fn read_with_deadline(stream: &mut TcpStream, limit: Duration) -> (Vec<u8>, Duration) {
    stream.set_read_timeout(Some(limit)).unwrap();
    let start = Instant::now();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    (response, start.elapsed())
}

#[test]
fn a_connection_that_sends_its_head_too_slowly_is_closed() {
    let server = Server::start(|options| {
        let limits = imp_aly::http::Limits {
            head_timeout: Duration::from_millis(400),
            ..Default::default()
        };
        options.http = Some(limits);
    });
    let mut idle = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    let (bytes, elapsed) = read_with_deadline(&mut idle, Duration::from_secs(10));
    assert!(bytes.is_empty());
    assert!(elapsed < Duration::from_secs(5));
    let mut trickle = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    let start = Instant::now();
    let mut closed = false;
    for byte in b"GET / HTTP/1.1\r\nhost: x\r\nx-slow: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
        if trickle.write_all(&[*byte]).is_err() {
            closed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
        if start.elapsed() > Duration::from_secs(3) {
            break;
        }
    }
    let (bytes, _) = read_with_deadline(&mut trickle, Duration::from_secs(10));
    assert!(
        closed || parse_response(&bytes).status == 408,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    assert_eq!(server.call("GET", "/", None, &[]).status, 200);
}

#[test]
fn one_address_holds_only_its_share_of_the_connections() {
    let server = Server::start(|options| {
        let mut limits = imp_aly::http::Limits::with_connections(64);
        limits.max_client_connections = 3;
        options.http = Some(limits);
    });
    let held: Vec<TcpStream> = (0..3)
        .map(|_| TcpStream::connect(("127.0.0.1", server.port)).unwrap())
        .collect();
    std::thread::sleep(Duration::from_millis(200));
    let mut refused = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    let _ = refused.write_all(b"GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
    let (bytes, _) = read_with_deadline(&mut refused, Duration::from_secs(5));
    assert!(bytes.is_empty());
    drop(held);
    server.wait_for(|| server.call("GET", "/", None, &[]).status == 200);
}

#[test]
fn a_keep_alive_connection_serves_several_requests_and_closes_when_idle() {
    let server = Server::start(|options| {
        let limits = imp_aly::http::Limits {
            idle_timeout: Duration::from_millis(300),
            ..Default::default()
        };
        options.http = Some(limits);
    });
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream
        .write_all(b"GET / HTTP/1.1\r\nhost: x\r\n\r\nGET / HTTP/1.1\r\nhost: x\r\n\r\n")
        .unwrap();
    let (bytes, elapsed) = read_with_deadline(&mut stream, Duration::from_secs(10));
    let text = String::from_utf8_lossy(&bytes);
    assert_eq!(text.matches("HTTP/1.1 200 OK").count(), 2, "{text}");
    assert!(elapsed < Duration::from_secs(5));
}

#[test]
fn a_chunked_body_and_an_expect_continue_are_read() {
    let server = Server::start(|_| {});
    server.register();
    let body = format!("[{}]", record(r#""type":"error""#));
    let (head, tail) = body.split_at(10);
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    write!(
        stream,
        "POST /collect/myapp HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:x}\r\n{head}\r\n{:x}\r\n{tail}\r\n0\r\n\r\n",
        head.len(),
        tail.len()
    )
    .unwrap();
    let (bytes, _) = read_with_deadline(&mut stream, Duration::from_secs(10));
    assert_eq!(
        parse_response(&bytes).text,
        r#"{"accepted":1,"rejected":0}"#
    );
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    write!(
        stream,
        "POST /collect/myapp HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\nexpect: 100-continue\r\nconnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    let mut first = [0u8; 25];
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"HTTP/1.1 100 Continue\r\n\r\n");
    stream.write_all(body.as_bytes()).unwrap();
    let (bytes, _) = read_with_deadline(&mut stream, Duration::from_secs(10));
    assert_eq!(parse_response(&bytes).status, 202);
}

#[test]
fn a_smuggled_or_oversized_head_is_refused() {
    let server = Server::start(|_| {});
    let refuse = |request: &str| {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let (bytes, _) = read_with_deadline(&mut stream, Duration::from_secs(10));
        parse_response(&bytes).status
    };
    assert_eq!(
        refuse(
            "POST /collect/myapp HTTP/1.1\r\ncontent-length: 4\r\ntransfer-encoding: chunked\r\n\r\n"
        ),
        400
    );
    assert_eq!(
        refuse(&format!(
            "GET / HTTP/1.1\r\nx: {}\r\n\r\n",
            "a".repeat(40_000)
        )),
        431
    );
    assert_eq!(refuse("GET / HTTP/3\r\n\r\n"), 505);
    assert_eq!(server.call("GET", "/", None, &[]).status, 200);
}
