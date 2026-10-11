use crate::days::{iso, now_ms};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

static DEBUG: AtomicBool = AtomicBool::new(false);

static QUIET: AtomicBool = AtomicBool::new(false);

pub fn set_debug(value: bool) {
    DEBUG.store(value, Ordering::Relaxed);
}

pub fn set_quiet(value: bool) {
    QUIET.store(value, Ordering::Relaxed);
}

pub fn is_debug() -> bool {
    DEBUG.load(Ordering::Relaxed)
}

pub fn is_quiet() -> bool {
    QUIET.load(Ordering::Relaxed)
}

fn write(level: &str, text: &str) {
    if is_quiet() {
        return;
    }
    let line = format!("{} {level} {text}\n", iso(now_ms()));
    if level == "ERROR" || level == "WARN" {
        let _ = std::io::stderr().write_all(line.as_bytes());
    } else {
        let _ = std::io::stdout().write_all(line.as_bytes());
    }
}

pub fn info(text: impl AsRef<str>) {
    write("INFO", text.as_ref());
}

pub fn warn(text: impl AsRef<str>) {
    write("WARN", text.as_ref());
}

pub fn error(text: impl AsRef<str>) {
    write("ERROR", text.as_ref());
}

pub fn debug(text: impl AsRef<str>) {
    if is_debug() {
        write("DEBUG", text.as_ref());
    }
}

pub fn plain(text: impl AsRef<str>) {
    if !is_quiet() {
        let _ = writeln!(std::io::stdout(), "{}", text.as_ref());
    }
}
