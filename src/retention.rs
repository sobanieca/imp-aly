use crate::column_store::{
    app_dir, is_summary_only_day, keep_only_summary, list_apps, list_days, list_sources, source_dir,
};
use crate::days::{PERIOD_KINDS, PeriodKind, day_of};
use crate::error::{Error, Result};
use crate::fsutil::{list_directory, remove_if_exists, rename};
use crate::logger;
use crate::paths::join;
use crate::periods::{list_periods, periods_dir};
use std::ffi::CString;

pub const DEFAULT_MIN_FREE: &str = "10%";

const TRASH_SUFFIX: &str = ".trash";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MinFree {
    Percent(f64),
    Bytes(u64),
}

fn number(text: &str) -> Option<f64> {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|part| !digits(part)) {
        return None;
    }
    text.parse().ok()
}

pub fn parse_min_free(text: &str) -> std::result::Result<MinFree, String> {
    let value = text.trim().to_uppercase();
    if let Some(percent) = value.strip_suffix('%').and_then(number)
        && percent > 0.0
        && percent < 100.0
    {
        return Ok(MinFree::Percent(percent));
    }
    for (unit, size) in [
        ("TB", 1024f64.powi(4)),
        ("GB", 1024f64.powi(3)),
        ("MB", 1024f64.powi(2)),
        ("KB", 1024.0),
        ("B", 1.0),
    ] {
        if let Some(amount) = value.strip_suffix(unit).and_then(number)
            && amount > 0.0
        {
            return Ok(MinFree::Bytes((amount * size).round() as u64));
        }
    }
    Err(format!(
        "--min-free \"{text}\" is not a size - use a percent like 10% or a size like 5GB"
    ))
}

pub fn min_free_bytes(min_free: MinFree, total_bytes: u64) -> u64 {
    match min_free {
        MinFree::Bytes(bytes) => bytes,
        MinFree::Percent(percent) => (total_bytes as f64 * percent / 100.0).ceil() as u64,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub total_bytes: u64,
    pub free_bytes: u64,
}

pub fn disk_usage(path: &str) -> Result<Usage> {
    let text = CString::new(path).map_err(|_| Error::new(format!("{path} is not a path")))?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let code = unsafe { libc::statvfs(text.as_ptr(), &mut stats) };
    if code != 0 {
        return Err(Error::new(format!(
            "cannot read the free disk space of {path}: {}",
            std::io::Error::last_os_error()
        )));
    }
    let unit = stats.f_frsize as u64;
    Ok(Usage {
        total_bytes: stats.f_blocks as u64 * unit,
        free_bytes: stats.f_bavail as u64 * unit,
    })
}

pub type UsageFn = dyn Fn(&str) -> Result<Usage> + Send + Sync;

fn remove_trash(data_dir: &str) -> Result<()> {
    for app in list_apps(data_dir)? {
        let mut folders = vec![app_dir(data_dir, &app)];
        folders.extend(
            PERIOD_KINDS
                .iter()
                .map(|kind| periods_dir(data_dir, &app, *kind)),
        );
        for folder in folders {
            for entry in list_directory(&folder)? {
                if entry.name.ends_with(TRASH_SUFFIX) {
                    remove_if_exists(&join(&[&folder, &entry.name]))?;
                }
            }
        }
    }
    Ok(())
}

fn by_id_then_app(a: &(String, String), b: &(String, String)) -> std::cmp::Ordering {
    a.1.cmp(&b.1).then(a.0.cmp(&b.0))
}

fn list_stored_periods(data_dir: &str, kind: PeriodKind) -> Result<Vec<(String, String)>> {
    let mut periods = Vec::new();
    for app in list_apps(data_dir)? {
        for id in list_periods(data_dir, &app, kind)? {
            periods.push((app.clone(), id));
        }
    }
    periods.sort_by(by_id_then_app);
    Ok(periods)
}

pub fn list_stored_days(data_dir: &str) -> Result<Vec<(String, String)>> {
    let mut days = Vec::new();
    for app in list_apps(data_dir)? {
        for day in list_days(data_dir, &app)? {
            days.push((app.clone(), day));
        }
    }
    days.sort_by(by_id_then_app);
    Ok(days)
}

fn holds_only_summaries(data_dir: &str, app: &str, day: &str) -> Result<bool> {
    let sources = list_sources(data_dir, app, day)?;
    if sources.is_empty() {
        return Ok(false);
    }
    for source in sources {
        if !is_summary_only_day(&source_dir(data_dir, app, day, &source))? {
            return Ok(false);
        }
    }
    Ok(true)
}

struct Candidate {
    app: String,
    day: String,
    summary_only: bool,
}

fn removal_order(data_dir: &str, today: &str) -> Result<Vec<Candidate>> {
    let mut with_records = Vec::new();
    let mut summary_only = Vec::new();
    for (app, day) in list_stored_days(data_dir)? {
        if day.as_str() >= today {
            continue;
        }
        if holds_only_summaries(data_dir, &app, &day)? {
            summary_only.push(Candidate {
                app,
                day,
                summary_only: true,
            });
        } else {
            with_records.push(Candidate {
                app,
                day,
                summary_only: false,
            });
        }
    }
    with_records.extend(summary_only);
    Ok(with_records)
}

fn remove_folder(folder: &str, name: &str) -> Result<()> {
    let trash = join(&[folder, &format!("{name}{TRASH_SUFFIX}")]);
    rename(&join(&[folder, name]), &trash)?;
    remove_if_exists(&trash)?;
    Ok(())
}

fn keep_only_summaries(data_dir: &str, app: &str, day: &str) -> Result<bool> {
    let mut reduced = false;
    for source in list_sources(data_dir, app, day)? {
        let path = source_dir(data_dir, app, day, &source);
        match keep_only_summary(&path) {
            Ok(true) => reduced = true,
            Ok(false) => {}
            Err(error) => logger::warn(format!("Cannot keep the daily summary of {path}: {error}")),
        }
    }
    Ok(reduced)
}

pub struct Retention {
    pub usage: Usage,
    pub needed_bytes: u64,
    pub summarized: Vec<String>,
    pub removed: Vec<String>,
}

pub fn enforce_retention(
    data_dir: &str,
    min_free: MinFree,
    usage: &dyn Fn(&str) -> Result<Usage>,
    now: i64,
) -> Result<Retention> {
    let mut current = usage(data_dir)?;
    let needed = min_free_bytes(min_free, current.total_bytes);
    let mut result = Retention {
        usage: current,
        needed_bytes: needed,
        summarized: Vec::new(),
        removed: Vec::new(),
    };
    if current.free_bytes >= needed {
        return Ok(result);
    }
    remove_trash(data_dir)?;
    let today = day_of(now);
    let enough = |current: &mut Usage| -> Result<bool> {
        *current = usage(data_dir)?;
        Ok(current.free_bytes >= needed)
    };
    'summarize: for candidate in removal_order(data_dir, &today)? {
        if candidate.summary_only {
            break 'summarize;
        }
        if !keep_only_summaries(data_dir, &candidate.app, &candidate.day)? {
            continue;
        }
        result
            .summarized
            .push(format!("{}/{}", candidate.app, candidate.day));
        logger::info(format!(
            "Removed the records of {}/{} to keep free disk space, kept its summary",
            candidate.app, candidate.day
        ));
        if enough(&mut current)? {
            break;
        }
    }
    for with_summary_only in [false, true] {
        if current.free_bytes >= needed {
            break;
        }
        for candidate in removal_order(data_dir, &today)? {
            if candidate.summary_only != with_summary_only {
                continue;
            }
            remove_folder(&app_dir(data_dir, &candidate.app), &candidate.day)?;
            result
                .removed
                .push(format!("{}/{}", candidate.app, candidate.day));
            logger::info(format!(
                "Removed {}/{} to keep free disk space",
                candidate.app, candidate.day
            ));
            if enough(&mut current)? {
                break;
            }
        }
    }
    for kind in PERIOD_KINDS {
        if current.free_bytes >= needed {
            break;
        }
        for (app, id) in list_stored_periods(data_dir, kind)? {
            remove_folder(&periods_dir(data_dir, &app, kind), &id)?;
            result.removed.push(format!("{app}/{}/{id}", kind.dir()));
            logger::info(format!(
                "Removed the summary of {app}/{}/{id} to keep free disk space",
                kind.dir()
            ));
            if enough(&mut current)? {
                break;
            }
        }
    }
    if current.free_bytes < needed {
        logger::warn(format!(
            "Free disk space is {} bytes, below {needed} bytes, and no older day or summary is left to remove",
            current.free_bytes
        ));
    }
    result.usage = current;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_free_takes_a_percent_or_a_size() {
        assert_eq!(parse_min_free("10%"), Ok(MinFree::Percent(10.0)));
        assert_eq!(parse_min_free(" 2.5% "), Ok(MinFree::Percent(2.5)));
        assert_eq!(
            parse_min_free("5GB"),
            Ok(MinFree::Bytes(5 * 1024 * 1024 * 1024))
        );
        assert_eq!(parse_min_free("1.5kb"), Ok(MinFree::Bytes(1536)));
        assert_eq!(parse_min_free("100B"), Ok(MinFree::Bytes(100)));
        for bad in ["0%", "100%", "-5GB", "5", "GB", "5 GB", "1e3B"] {
            assert!(parse_min_free(bad).is_err(), "{bad}");
        }
        assert_eq!(min_free_bytes(MinFree::Percent(10.0), 1001), 101);
    }

    #[test]
    fn reads_the_disk_usage_of_a_folder() {
        let usage = disk_usage("/").unwrap();
        assert!(usage.total_bytes > 0);
        assert!(usage.free_bytes <= usage.total_bytes);
    }
}
