use crate::days::{DAY_MS, now_ms, parse_iso};
use crate::error::{Error, Result};
use crate::fsutil::{read_json, remove_if_exists, sync_directory, write_json_atomic};
use crate::json::{self, Object, Value};
use crate::paths::{basename, dirname, home, join};
use crate::token::{Sha256, is_hash};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const MANIFEST_URL: &str = "https://sobanieca.github.io/imp-aly/versions.json";

pub const DOWNLOAD_URL: &str = "https://github.com/sobanieca/imp-aly/releases/download";

pub const RELEASES_URL: &str = "https://github.com/sobanieca/imp-aly/releases";

pub const RELEASES_API_URL: &str =
    "https://api.github.com/repos/sobanieca/imp-aly/releases?per_page=100";

pub const MIN_RELEASE_AGE_DAYS: i64 = 7;

pub const UPDATE_STATE_DIR: &str = "/var/lib/imp-aly-update";

const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

const MAX_MANIFEST_BYTES: u64 = 16 << 20;

const MAX_BINARY_BYTES: u64 = 512 << 20;

pub fn parse_version(text: &str) -> Option<[u64; 3]> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut out = [0u64; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || part.len() > 15
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        out[index] = part.parse().ok()?;
    }
    Some(out)
}

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    parse_version(a).cmp(&parse_version(b))
}

pub fn is_auto_compatible(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some([0, minor, _]), Some([major, candidate_minor, _])) => {
            major == 0 && candidate_minor == minor
        }
        (Some([major, _, _]), Some([candidate_major, _, _])) => candidate_major == major,
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub format: i64,
    pub published: Option<i64>,
}

pub fn parse_manifest(value: &Value) -> Result<Vec<Release>> {
    let Some(versions) = value.get("versions").and_then(Value::as_array) else {
        return Err(Error::new("the version list has no \"versions\" array"));
    };
    Ok(versions
        .iter()
        .filter_map(|entry| {
            let version = entry.get_str("version")?;
            parse_version(version)?;
            let format = entry.get("format")?.as_safe_integer()?;
            Some(Release {
                version: version.to_string(),
                format,
                published: None,
            })
        })
        .collect())
}

pub fn parse_releases(value: &Value) -> Result<HashMap<String, i64>> {
    let Some(list) = value.as_array() else {
        return Err(Error::new("the GitHub API sent no list of releases"));
    };
    let mut published = HashMap::new();
    for release in list {
        let Some(tag) = release.get_str("tag_name") else {
            continue;
        };
        let Some(version) = tag
            .strip_prefix('v')
            .filter(|version| parse_version(version).is_some())
        else {
            continue;
        };
        let flag = |name: &str| release.get(name).and_then(Value::as_bool).unwrap_or(false);
        if flag("draft") || flag("prerelease") {
            continue;
        }
        let Some(at) = release.get_str("published_at").and_then(parse_iso) else {
            continue;
        };
        published.insert(version.to_string(), at);
    }
    Ok(published)
}

pub fn with_publish_dates(
    versions: Vec<Release>,
    published: &HashMap<String, i64>,
) -> Vec<Release> {
    versions
        .into_iter()
        .map(|release| Release {
            published: published.get(&release.version).copied(),
            ..release
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    Format,
    Major,
    Age,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub version: String,
    pub reason: Hold,
    pub published: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub target: Option<String>,
    pub held: Vec<Held>,
}

fn release_age_ready(published: Option<i64>, now: i64) -> bool {
    published.is_some_and(|published| now - published > MIN_RELEASE_AGE_DAYS * DAY_MS)
}

pub struct Pick<'a> {
    pub current: &'a str,
    pub format: i64,
    pub versions: &'a [Release],
    pub skipped: &'a [String],
    pub auto: bool,
    pub now: i64,
}

pub fn pick_update(pick: &Pick) -> Choice {
    let mut newer: Vec<&Release> = pick
        .versions
        .iter()
        .filter(|release| compare_versions(&release.version, pick.current).is_gt())
        .collect();
    newer.sort_by(|a, b| compare_versions(&b.version, &a.version));
    let mut held = Vec::new();
    for release in newer {
        let reason = if release.format != pick.format {
            Some(Hold::Format)
        } else if pick.auto && !is_auto_compatible(pick.current, &release.version) {
            Some(Hold::Major)
        } else if pick.auto && !release_age_ready(release.published, pick.now) {
            Some(Hold::Age)
        } else if pick.skipped.contains(&release.version) {
            Some(Hold::Skipped)
        } else {
            None
        };
        match reason {
            None => {
                return Choice {
                    target: Some(release.version.clone()),
                    held,
                };
            }
            Some(reason) => held.push(Held {
                version: release.version.clone(),
                reason,
                published: release.published,
            }),
        }
    }
    Choice { target: None, held }
}

pub fn asset_name(os: &str, arch: &str) -> Result<String> {
    let os_name = match os {
        "linux" => "linux",
        "macos" => "macos",
        _ => {
            return Err(Error::new(format!(
                "imp-aly has no release for {os} on {arch}"
            )));
        }
    };
    let arch_name = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => {
            return Err(Error::new(format!(
                "imp-aly has no release for {os} on {arch}"
            )));
        }
    };
    Ok(format!("imp-aly-{os_name}-{arch_name}"))
}

pub fn current_asset() -> Result<String> {
    asset_name(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn staged_path(binary: &str) -> String {
    join(&[&dirname(binary), &format!(".{}.new", basename(binary))])
}

pub fn previous_path(binary: &str) -> String {
    join(&[&dirname(binary), &format!(".{}.previous", basename(binary))])
}

pub fn state_dir() -> String {
    if unsafe { libc::getuid() } == 0 {
        return UPDATE_STATE_DIR.to_string();
    }
    let base = std::env::var("XDG_STATE_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| join(&[&home(), ".local", "state"]));
    join(&[&base, "imp-aly"])
}

pub type Fetch = dyn Fn(&str, Duration, &[(&str, &str)]) -> Result<Box<dyn Read + Send>>;

pub fn http_get(
    url: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<Box<dyn Read + Send>> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .user_agent(format!("imp-aly/{}", crate::VERSION))
        .build()
        .into();
    let mut request = agent.get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request
        .call()
        .map_err(|error| Error::new(format!("{url}: {error}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(Error::new(format!("{url} answered {status}")));
    }
    Ok(Box::new(response.into_body().into_reader()))
}

fn read_limited(reader: Box<dyn Read + Send>, limit: u64, url: &str) -> Result<String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Error::new(format!("{url}: {error}")))?;
    if bytes.len() as u64 > limit {
        return Err(Error::new(format!("{url} sent more than {limit} bytes")));
    }
    String::from_utf8(bytes).map_err(|_| Error::new(format!("{url} sent text that is not UTF-8")))
}

fn get_json(fetch: &Fetch, url: &str, headers: &[(&str, &str)]) -> Result<Value> {
    let text = read_limited(
        fetch(url, MANIFEST_TIMEOUT, headers)?,
        MAX_MANIFEST_BYTES,
        url,
    )?;
    json::parse(&text).map_err(|_| Error::new(format!("{url} sent text that is not JSON")))
}

pub fn fetch_versions(fetch: &Fetch, manifest_url: &str) -> Result<Vec<Release>> {
    parse_manifest(&get_json(fetch, manifest_url, &[])?)
}

pub fn fetch_publish_dates(fetch: &Fetch, releases_url: &str) -> Result<HashMap<String, i64>> {
    parse_releases(&get_json(
        fetch,
        releases_url,
        &[("accept", "application/vnd.github+json")],
    )?)
}

pub fn read_skipped(dir: &str) -> Result<Vec<String>> {
    let stored = read_json(&join(&[dir, "skipped.json"]))?;
    Ok(stored
        .as_ref()
        .and_then(|value| value.get("versions"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

pub fn add_skipped(dir: &str, version: &str) -> Result<()> {
    fs::create_dir_all(dir).map_err(|error| Error::io(&error, dir))?;
    let mut versions = read_skipped(dir)?;
    if versions.iter().any(|entry| entry == version) {
        return Ok(());
    }
    versions.push(version.to_string());
    write_json_atomic(
        &join(&[dir, "skipped.json"]),
        &Object::new().with("versions", versions).into(),
    )
}

pub fn lock_updates(dir: &str) -> Result<File> {
    fs::create_dir_all(dir).map_err(|error| Error::io(&error, dir))?;
    let path = join(&[dir, "lock"]);
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| Error::io(&error, &path))?;
    file.try_lock()
        .map_err(|_| Error::new("another imp-aly update runs now"))?;
    Ok(file)
}

pub fn reported_version(binary: &str) -> Option<String> {
    let mut child = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out.trim().to_string());
            }
            Ok(None) if start.elapsed() < VERSION_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

pub fn check_installed(binary: &str, running: &str) -> Result<()> {
    let installed = reported_version(binary);
    if installed.as_deref() != Some(running) {
        return Err(Error::new(format!(
            "{binary} is imp-aly {} now, not {running} - another update replaced it, run imp-aly update again",
            installed.unwrap_or_else(|| "of an unknown version".to_string())
        )));
    }
    Ok(())
}

fn open_staged(path: &str) -> Result<File> {
    remove_if_exists(path)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(path)
        .map_err(|error| {
            if error.kind() == ErrorKind::PermissionDenied {
                Error::new(format!(
                    "cannot write {} - run: sudo imp-aly update",
                    dirname(path)
                ))
            } else {
                Error::io(&error, path)
            }
        })
}

pub struct Stage<'a> {
    pub binary: &'a str,
    pub version: &'a str,
    pub fetch: &'a Fetch,
    pub download_url: &'a str,
    pub asset: &'a str,
}

pub fn stage_binary(stage: &Stage) -> Result<String> {
    let staged = staged_path(stage.binary);
    let mut file = Some(open_staged(&staged)?);
    let result = (|| -> Result<()> {
        let mut output = file
            .take()
            .ok_or_else(|| Error::new("the staged file is not open"))?;
        let url = format!("{}/v{}/{}", stage.download_url, stage.version, stage.asset);
        let sums_url = format!("{url}.sha256");
        let sums = read_limited(
            (stage.fetch)(&sums_url, DOWNLOAD_TIMEOUT, &[])?,
            4096,
            &sums_url,
        )?;
        let mut fields = sums.split_whitespace();
        let expected = fields.next().unwrap_or("");
        let name = fields.next().map(|name| name.trim_start_matches('*'));
        if !is_hash(expected) || name != Some(stage.asset) {
            return Err(Error::new(format!(
                "{sums_url} holds no SHA-256 of {}",
                stage.asset
            )));
        }
        let mut hash = Sha256::new();
        let mut reader = (stage.fetch)(&url, DOWNLOAD_TIMEOUT, &[])?;
        let mut buffer = vec![0u8; 1 << 16];
        let mut total = 0u64;
        loop {
            let size = reader
                .read(&mut buffer)
                .map_err(|error| Error::new(format!("{url}: {error}")))?;
            if size == 0 {
                break;
            }
            total += size as u64;
            if total > MAX_BINARY_BYTES {
                return Err(Error::new(format!(
                    "{url} sent more than {MAX_BINARY_BYTES} bytes"
                )));
            }
            hash.update(&buffer[..size]);
            output
                .write_all(&buffer[..size])
                .map_err(|error| Error::io(&error, &staged))?;
        }
        output
            .sync_data()
            .map_err(|error| Error::io(&error, &staged))?;
        drop(output);
        if hash.hex() != expected {
            return Err(Error::new(format!(
                "the checksum of {} {} does not match",
                stage.asset, stage.version
            )));
        }
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
            .map_err(|error| Error::io(&error, &staged))?;
        let reported = reported_version(&staged);
        if reported.as_deref() != Some(stage.version) {
            return Err(Error::new(format!(
                "the downloaded binary reports the version {}, not {}",
                reported.map_or("null".to_string(), |text| json::quote(&text)),
                stage.version
            )));
        }
        Ok(())
    })();
    drop(file);
    if let Err(error) = result {
        let _ = remove_if_exists(&staged);
        return Err(error);
    }
    Ok(staged)
}

pub fn swap_binary(binary: &str, staged: &str) -> Result<String> {
    let previous = previous_path(binary);
    remove_if_exists(&previous)?;
    fs::hard_link(binary, &previous).map_err(|error| Error::io(&error, binary))?;
    fs::rename(staged, binary).map_err(|error| Error::io(&error, staged))?;
    sync_directory(&dirname(binary))?;
    Ok(previous)
}

pub fn restore_previous(binary: &str) -> Result<()> {
    fs::rename(previous_path(binary), binary).map_err(|error| Error::io(&error, binary))?;
    sync_directory(&dirname(binary))
}

pub fn now() -> i64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn release(version: &str, format: i64, published: Option<i64>) -> Release {
        Release {
            version: version.to_string(),
            format,
            published,
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    fn pick(current: &str, versions: &[Release], auto: bool, skipped: &[String]) -> Choice {
        pick_update(&Pick {
            current,
            format: 3,
            versions,
            skipped,
            auto,
            now: NOW,
        })
    }

    #[test]
    fn versions_parse_and_compare_as_numbers() {
        assert_eq!(parse_version("1.10.2"), Some([1, 10, 2]));
        assert_eq!(parse_version("01.0.0"), None);
        assert_eq!(parse_version("1.0"), None);
        assert!(compare_versions("0.10.0", "0.9.9").is_gt());
    }

    #[test]
    fn the_timer_stays_in_the_minor_version_before_1_and_in_the_major_version_after_it() {
        assert!(is_auto_compatible("0.2.0", "0.2.5"));
        assert!(!is_auto_compatible("0.2.0", "0.3.0"));
        assert!(!is_auto_compatible("0.2.0", "1.0.0"));
        assert!(is_auto_compatible("1.2.0", "1.9.0"));
        assert!(!is_auto_compatible("1.2.0", "2.0.0"));
    }

    #[test]
    fn a_manual_update_installs_the_newest_newer_version_with_the_same_data_format() {
        let versions = [
            release("0.2.1", 3, None),
            release("0.3.0", 3, None),
            release("0.4.0", 4, None),
        ];
        let choice = pick("0.2.0", &versions, false, &[]);
        assert_eq!(choice.target.as_deref(), Some("0.3.0"));
        assert_eq!(choice.held[0].reason, Hold::Format);
    }

    #[test]
    fn the_timer_installs_only_a_patch_published_over_7_days_ago() {
        let old = Some(NOW - 8 * DAY_MS);
        let fresh = Some(NOW - DAY_MS);
        let versions = [
            release("0.2.2", 3, fresh),
            release("0.2.1", 3, old),
            release("0.3.0", 3, old),
        ];
        let choice = pick("0.2.0", &versions, true, &[]);
        assert_eq!(choice.target.as_deref(), Some("0.2.1"));
        let reasons: Vec<Hold> = choice.held.iter().map(|held| held.reason).collect();
        assert_eq!(reasons, [Hold::Major, Hold::Age]);
        let none = pick("0.2.0", &[release("0.2.1", 3, None)], true, &[]);
        assert_eq!(none.target, None);
        let skipped = pick(
            "0.2.0",
            &[release("0.2.1", 3, old)],
            true,
            &["0.2.1".to_string()],
        );
        assert_eq!(skipped.held[0].reason, Hold::Skipped);
        assert_eq!(
            pick("0.2.1", &[release("0.2.0", 3, old)], false, &[]).target,
            None
        );
    }

    #[test]
    fn the_publish_dates_come_from_the_github_api_without_drafts_and_prereleases() {
        let value = json::parse(
            r#"[{"tag_name":"v0.2.1","published_at":"2026-10-01T10:00:00Z"},{"tag_name":"v0.2.2","draft":true,"published_at":"2026-10-02T10:00:00Z"},{"tag_name":"v0.2.3","prerelease":true,"published_at":"2026-10-02T10:00:00Z"},{"tag_name":"nightly"}]"#,
        )
        .unwrap();
        let dates = parse_releases(&value).unwrap();
        assert_eq!(dates.len(), 1);
        assert_eq!(
            dates.get("0.2.1").copied(),
            parse_iso("2026-10-01T10:00:00Z")
        );
        let manifest = json::parse(r#"{"versions":[{"version":"0.2.0","format":3},{"version":"x","format":3},{"version":"0.1.0"}]}"#).unwrap();
        assert_eq!(
            parse_manifest(&manifest).unwrap(),
            [release("0.2.0", 3, None)]
        );
    }

    #[test]
    fn the_asset_name_follows_the_platform() {
        assert_eq!(asset_name("linux", "x86_64").unwrap(), "imp-aly-linux-x64");
        assert_eq!(
            asset_name("macos", "aarch64").unwrap(),
            "imp-aly-macos-arm64"
        );
        assert!(asset_name("windows", "x86_64").is_err());
    }

    fn script(dir: &TempDir, version: &str) -> Vec<u8> {
        let _ = dir;
        format!("#!/bin/sh\necho {version}\n").into_bytes()
    }

    #[test]
    fn an_update_stages_a_checked_binary_swaps_it_in_one_step_and_can_put_the_old_one_back() {
        let dir = TempDir::new();
        let binary = dir.join("imp-aly");
        fs::write(&binary, script(&dir, "0.2.0")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let body = script(&dir, "0.2.1");
        let digest = crate::token::sha256_hex(&body);
        let fetch =
            move |url: &str, _: Duration, _: &[(&str, &str)]| -> Result<Box<dyn Read + Send>> {
                if url.ends_with(".sha256") {
                    Ok(Box::new(std::io::Cursor::new(
                        format!("{digest}  imp-aly-linux-x64\n").into_bytes(),
                    )))
                } else {
                    Ok(Box::new(std::io::Cursor::new(body.clone())))
                }
            };
        let staged = stage_binary(&Stage {
            binary: &binary,
            version: "0.2.1",
            fetch: &fetch,
            download_url: "https://example.invalid",
            asset: "imp-aly-linux-x64",
        })
        .unwrap();
        let previous = swap_binary(&binary, &staged).unwrap();
        assert_eq!(reported_version(&binary).as_deref(), Some("0.2.1"));
        assert_eq!(reported_version(&previous).as_deref(), Some("0.2.0"));
        restore_previous(&binary).unwrap();
        assert_eq!(reported_version(&binary).as_deref(), Some("0.2.0"));
        check_installed(&binary, "0.2.0").unwrap();
        assert!(check_installed(&binary, "0.2.1").is_err());
    }

    #[test]
    fn an_update_refuses_a_download_with_a_wrong_checksum_or_a_wrong_version() {
        let dir = TempDir::new();
        let binary = dir.join("imp-aly");
        fs::write(&binary, script(&dir, "0.2.0")).unwrap();
        let body = script(&dir, "0.2.9");
        let digest = crate::token::sha256_hex(&body);
        let wrong =
            move |url: &str, _: Duration, _: &[(&str, &str)]| -> Result<Box<dyn Read + Send>> {
                if url.ends_with(".sha256") {
                    Ok(Box::new(std::io::Cursor::new(
                        format!("{}  imp-aly-linux-x64\n", "0".repeat(64)).into_bytes(),
                    )))
                } else {
                    Ok(Box::new(std::io::Cursor::new(b"x".to_vec())))
                }
            };
        let stage = |fetch: &Fetch| {
            stage_binary(&Stage {
                binary: &binary,
                version: "0.2.1",
                fetch,
                download_url: "https://example.invalid",
                asset: "imp-aly-linux-x64",
            })
        };
        assert!(stage(&wrong).unwrap_err().message.contains("checksum"));
        let mislabeled =
            move |url: &str, _: Duration, _: &[(&str, &str)]| -> Result<Box<dyn Read + Send>> {
                if url.ends_with(".sha256") {
                    Ok(Box::new(std::io::Cursor::new(
                        format!("{digest}  imp-aly-linux-x64\n").into_bytes(),
                    )))
                } else {
                    Ok(Box::new(std::io::Cursor::new(body.clone())))
                }
            };
        assert!(
            stage(&mislabeled)
                .unwrap_err()
                .message
                .contains("reports the version")
        );
        assert!(!std::path::Path::new(&staged_path(&binary)).exists());
    }

    #[test]
    fn the_skip_list_and_the_update_lock_live_in_the_state_folder() {
        let dir = TempDir::new();
        add_skipped(&dir.path, "0.2.1").unwrap();
        add_skipped(&dir.path, "0.2.1").unwrap();
        assert_eq!(read_skipped(&dir.path).unwrap(), ["0.2.1"]);
        let lock = lock_updates(&dir.path).unwrap();
        assert!(lock_updates(&dir.path).is_err());
        drop(lock);
        assert!(lock_updates(&dir.path).is_ok());
    }
}
