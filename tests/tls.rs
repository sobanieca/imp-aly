mod support;

use imp_aly::testing::TempDir;
use std::fs::{self, File};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use support::*;

fn has_openssl() -> bool {
    Command::new("openssl")
        .arg("version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

struct Pair {
    cert: String,
    key: String,
}

fn make_certificate(dir: &str, name: &str) -> Pair {
    let key_path = format!("{dir}/{name}-key.pem");
    let cert_path = format!("{dir}/{name}-cert.pem");
    let status = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "2",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-keyout",
            &key_path,
            "-out",
            &cert_path,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "openssl made a certificate");
    Pair {
        cert: fs::read_to_string(cert_path).unwrap(),
        key: fs::read_to_string(key_path).unwrap(),
    }
}

fn install(dir: &str, pair: &Pair, seconds: u64) {
    for (name, text) in [("cert.pem", &pair.cert), ("key.pem", &pair.key)] {
        let path = format!("{dir}/{name}");
        fs::write(&path, text).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }
}

fn answers(port: u16, cert: &str) -> bool {
    let Ok(certificate) = ureq::tls::Certificate::from_pem(cert.as_bytes()) else {
        return false;
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::new_with_certs(&[
                    certificate.to_owned()
                ]))
                .build(),
        )
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();
    agent
        .get(&format!("https://localhost:{port}/"))
        .call()
        .is_ok_and(|response| response.status().as_u16() == 200)
}

fn wait_until(mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "the condition did not happen in time"
        );
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn a_changed_certificate_is_loaded_and_a_broken_one_keeps_the_old() {
    if !has_openssl() {
        return;
    }
    let dir = TempDir::new();
    let first = make_certificate(&dir.path, "first");
    let second = make_certificate(&dir.path, "second");
    install(&dir.path, &first, 1_000);
    let path = dir.path.clone();
    let server = Server::start(|options| {
        options.tls_cert = Some(format!("{path}/cert.pem"));
        options.tls_key = Some(format!("{path}/key.pem"));
        options.tls_check_ms = 30;
    });
    assert!(answers(server.port, &first.cert));
    assert!(!answers(server.port, &second.cert));
    install(&dir.path, &second, 2_000);
    wait_until(|| answers(server.port, &second.cert));
    assert!(!answers(server.port, &first.cert));
    install(
        &dir.path,
        &Pair {
            cert: "broken".to_string(),
            key: "broken".to_string(),
        },
        3_000,
    );
    std::thread::sleep(Duration::from_millis(150));
    assert!(answers(server.port, &second.cert));
}

#[test]
fn a_change_of_the_watched_files_calls_the_given_handler() {
    if !has_openssl() {
        return;
    }
    let dir = TempDir::new();
    let first = make_certificate(&dir.path, "first");
    install(&dir.path, &first, 1_000);
    let source = format!("{}/source.pem", dir.path);
    fs::write(&source, "a").unwrap();
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    let path = dir.path.clone();
    let watched = source.clone();
    let _server = Server::start(move |options| {
        options.tls_cert = Some(format!("{path}/cert.pem"));
        options.tls_key = Some(format!("{path}/key.pem"));
        options.tls_watch = Some(vec![watched]);
        options.tls_check_ms = 30;
        options.on_tls_change = Some(Arc::new(move || {
            seen.lock().unwrap().push(SystemTime::now());
            true
        }));
    });
    fs::write(&source, "bb").unwrap();
    wait_until(|| changes.lock().unwrap().len() == 1);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(changes.lock().unwrap().len(), 1);
}
