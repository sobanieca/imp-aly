use super::status::selection;
use crate::api_client::{Body, Call, fetch_server, resolve_one};
use crate::args::{Parsed, require_only_flags};
use crate::backup::{BACKUP_KINDS, BACKUP_PERIODS, count_backup};
use crate::days::{day_of, now_ms};
use crate::error::{Error, Result};
use crate::fsutil::remove_if_exists;
use crate::logger;
use crate::url::encode_form;
use std::fs::File;
use std::io::{BufReader, Read, Write};

const USAGE: &str =
    "use: imp-aly backup [<file>] [--last <period>] [--by day|week|month] [-s <name>]";

fn plural(count: usize, word: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { word } else { many })
}

pub fn format_bytes(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

pub fn default_file_name(last: &str, by: &str, now: i64) -> String {
    format!("imp-aly-backup-{last}-by-{by}-{}.tar.gz", day_of(now))
}

fn empty_hint(by: &str) -> &'static str {
    match by {
        "week" => {
            "No complete week is in the period. A week is complete at 01:10 UTC on Monday, and all its days must be in the period."
        }
        "month" => {
            "No complete month is in the period. A month is complete at 01:10 UTC on the first day of the next month, and all its days must be in the period."
        }
        _ => "No sealed day is in the period. A day is sealed at 01:10 UTC of the next day.",
    }
}

pub fn backup(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth", "url", "server", "last", "by"], "backup")?;
    if parsed.positional.len() > 2 {
        return Err(Error::new(USAGE));
    }
    let last = parsed.get("last").unwrap_or("all");
    let by = parsed.get("by").unwrap_or("day");
    if !BACKUP_PERIODS.contains(&last) {
        return Err(Error::new(format!(
            "--last is one of {}",
            BACKUP_PERIODS.join(", ")
        )));
    }
    if !BACKUP_KINDS.contains(&by) {
        return Err(Error::new(format!(
            "--by is one of {}",
            BACKUP_KINDS.join(", ")
        )));
    }
    let file = parsed
        .positional
        .get(1)
        .cloned()
        .unwrap_or_else(|| default_file_name(last, by, now_ms()));
    let target = resolve_one(&selection(parsed))?;
    let path = format!("/backup?{}", encode_form(&[("last", last), ("by", by)]));
    let response = fetch_server(
        &target,
        Call {
            method: "GET",
            path: &path,
            body: Body::None,
            timeout_ms: None,
        },
    )?;
    let temporary = format!("{file}.tmp");
    let saved = (|| -> Result<crate::backup::BackupCount> {
        let mut output = File::create(&temporary).map_err(|error| Error::io(&error, &temporary))?;
        let mut reader = response.into_body().into_reader();
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let size = reader
                .read(&mut buffer)
                .map_err(|error| Error::new(error.to_string()))?;
            if size == 0 {
                break;
            }
            output
                .write_all(&buffer[..size])
                .map_err(|error| Error::io(&error, &temporary))?;
        }
        output
            .sync_all()
            .map_err(|error| Error::io(&error, &temporary))?;
        let counted = count_backup(BufReader::new(
            File::open(&temporary).map_err(|error| Error::io(&error, &temporary))?,
        ))?;
        std::fs::rename(&temporary, &file).map_err(|error| Error::io(&error, &file))?;
        Ok(counted)
    })();
    let counted = match saved {
        Ok(counted) => counted,
        Err(error) => {
            let _ = remove_if_exists(&temporary);
            return Err(Error::new(format!("the backup failed: {}", error.message)));
        }
    };
    let size = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
    let kinds = [
        (counted.days, "daily summary", "daily summaries", "day"),
        (counted.weeks, "week summary", "week summaries", "week"),
        (counted.months, "month summary", "month summaries", "month"),
    ];
    let present: Vec<String> = kinds
        .iter()
        .filter(|(count, ..)| *count > 0)
        .map(|(count, one, many, _)| plural(*count, one, many))
        .collect();
    let summaries = if present.is_empty() {
        kinds
            .iter()
            .filter(|(.., name)| *name == by)
            .map(|(count, one, many, _)| plural(*count, one, many))
            .collect::<Vec<_>>()
            .join(", ")
    } else {
        present.join(", ")
    };
    logger::plain(format!(
        "Saved {summaries} of {} and {} to {file} ({})",
        plural(counted.apps, "app", "apps"),
        plural(counted.sources, "source", "sources"),
        format_bytes(size)
    ));
    if present.is_empty() {
        logger::plain(empty_hint(by));
    }
    Ok(())
}
