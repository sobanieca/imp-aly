use crate::VERSION;
use crate::args::{Parsed, require_only_flags};
use crate::data_format::DATA_FORMAT;
use crate::days::day_of;
use crate::error::{Error, Result};
use crate::logger;
use crate::service::{SERVICE_NAME, executable, is_active, is_service_installed, restart_service};
use crate::update::{
    Choice, DOWNLOAD_URL, Hold, MANIFEST_URL, MIN_RELEASE_AGE_DAYS, Pick, RELEASES_API_URL,
    RELEASES_URL, Release, Stage, add_skipped, check_installed, current_asset, fetch_publish_dates,
    fetch_versions, http_get, is_auto_compatible, lock_updates, now, pick_update, read_skipped,
    restore_previous, stage_binary, state_dir, swap_binary, with_publish_dates,
};

fn held_note(version: &str, reason: Hold, published: Option<i64>, dir: &str) -> String {
    match reason {
        Hold::Format => format!(
            "imp-aly {version} reads another data format, so update does not install it. Read {RELEASES_URL}."
        ),
        Hold::Major => format!(
            "imp-aly {version} can change the data folder, the API or the commands, so the timer does not install it. Read {RELEASES_URL}, then run: sudo imp-aly update"
        ),
        Hold::Age => {
            let since = match published {
                None => "has no publish date on GitHub".to_string(),
                Some(at) => format!("is out since {}", day_of(at)),
            };
            format!(
                "imp-aly {version} {since}. The timer installs a version {MIN_RELEASE_AGE_DAYS} days after GitHub publishes it."
            )
        }
        Hold::Skipped => format!(
            "imp-aly {version} did not stay running here, so update does not install it. It is in {dir}/skipped.json."
        ),
    }
}

fn held_notes(choice: &Choice, dir: &str) -> Vec<String> {
    let mut seen = Vec::new();
    let mut notes = Vec::new();
    for held in &choice.held {
        if seen.contains(&held.reason) {
            continue;
        }
        seen.push(held.reason);
        notes.push(held_note(&held.version, held.reason, held.published, dir));
    }
    notes
}

fn load_versions(auto: bool) -> Result<Vec<Release>> {
    let versions = fetch_versions(&http_get, MANIFEST_URL)?;
    if !auto {
        return Ok(versions);
    }
    Ok(with_publish_dates(
        versions,
        &fetch_publish_dates(&http_get, RELEASES_API_URL)?,
    ))
}

fn choose(versions: &[Release], skipped: &[String], auto: bool) -> Choice {
    pick_update(&Pick {
        current: VERSION,
        format: i64::from(DATA_FORMAT),
        versions,
        skipped,
        auto,
        now: now(),
    })
}

fn print_check(dir: &str) -> Result<()> {
    let versions = load_versions(true)?;
    let skipped = read_skipped(dir)?;
    let manual = choose(&versions, &skipped, false);
    let timer = choose(&versions, &skipped, true);
    logger::plain(format!("Installed: {VERSION}"));
    logger::plain(format!(
        "Update:    {}  (sudo imp-aly update)",
        manual.target.as_deref().unwrap_or("none")
    ));
    logger::plain(format!(
        "Timer:     {}  (the daily update)",
        timer.target.as_deref().unwrap_or("none")
    ));
    for note in held_notes(&timer, dir) {
        logger::plain(note);
    }
    Ok(())
}

fn restart_checked() -> bool {
    match restart_service() {
        Ok(stayed) => stayed,
        Err(error) => {
            logger::error(&error.message);
            false
        }
    }
}

fn install_target(binary: &str, target: &str, dir: &str) -> Result<()> {
    logger::info(format!("Downloading imp-aly {target}"));
    let asset = current_asset()?;
    let staged = stage_binary(&Stage {
        binary,
        version: target,
        fetch: &http_get,
        download_url: DOWNLOAD_URL,
        asset: &asset,
    })?;
    let previous = swap_binary(binary, &staged)?;
    logger::info(format!(
        "Installed imp-aly {target} in {binary}. The old binary is {previous}"
    ));
    if !is_auto_compatible(VERSION, target) {
        logger::info(format!(
            "imp-aly {target} can change the unit file. Run your sudo imp-aly server command again after the restart."
        ));
    }
    if !is_service_installed() || !is_active() {
        logger::info("Restart the server to run the new version");
        return Ok(());
    }
    logger::info(format!("Restarting the service {SERVICE_NAME}"));
    if restart_checked() {
        logger::info(format!("The service {SERVICE_NAME} runs imp-aly {target}"));
        return Ok(());
    }
    restore_previous(binary)?;
    add_skipped(dir, target)?;
    let back = restart_checked();
    Err(Error::new(format!(
        "imp-aly {target} did not stay running, so imp-aly {VERSION} is back{} - check: journalctl -u {SERVICE_NAME} -n 50",
        if back {
            ""
        } else {
            ", but it did not stay running either"
        }
    )))
}

pub fn update(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["check", "auto"], "update")?;
    if parsed.positional.len() > 1 {
        return Err(Error::new("use: imp-aly update [--check] [--auto]"));
    }
    let binary = executable();
    let dir = state_dir();
    if parsed.has("check") {
        return print_check(&dir);
    }
    let auto = parsed.has("auto");
    let _lock = lock_updates(&dir)?;
    check_installed(&binary, VERSION)?;
    let choice = choose(&load_versions(auto)?, &read_skipped(&dir)?, auto);
    for note in held_notes(&choice, &dir) {
        logger::info(note);
    }
    let Some(target) = choice.target else {
        logger::info(format!(
            "imp-aly {VERSION} is the newest version that update can install"
        ));
        return Ok(());
    };
    install_target(&binary, &target, &dir)
}
