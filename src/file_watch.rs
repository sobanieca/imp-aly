use crate::logger;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl WatchHandle {
    pub fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        self.task.abort();
    }
}

fn stamps(paths: &[String]) -> Result<String, String> {
    let mut out = Vec::new();
    for path in paths {
        let meta = std::fs::metadata(path).map_err(|error| format!("{error}: {path}"))?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(String::new(), |elapsed| elapsed.as_millis().to_string());
        out.push(format!("{modified}:{}", meta.len()));
    }
    Ok(out.join(","))
}

pub fn watch_files(
    paths: Vec<String>,
    every: Duration,
    on_change: Arc<dyn Fn() -> bool + Send + Sync>,
) -> WatchHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let first = stamps(&paths);
    let task = tokio::spawn(async move {
        let mut last_problem: Option<String> = None;
        let mut warn = |problem: String| {
            if last_problem.as_deref() != Some(problem.as_str()) {
                logger::warn(format!(
                    "Cannot check {} for changes: {problem}",
                    paths.join(", ")
                ));
            }
            last_problem = Some(problem);
        };
        let mut known = match first {
            Ok(stamp) => Some(stamp),
            Err(problem) => {
                warn(problem);
                None
            }
        };
        let mut interval = tokio::time::interval(every);
        interval.tick().await;
        loop {
            interval.tick().await;
            if stopped.load(Ordering::Relaxed) {
                return;
            }
            let current = match stamps(&paths) {
                Ok(stamp) => stamp,
                Err(problem) => {
                    warn(problem);
                    continue;
                }
            };
            if known.is_none() {
                known = Some(current.clone());
            }
            if known.as_deref() == Some(current.as_str()) {
                continue;
            }
            let change = on_change.clone();
            let applied = tokio::task::spawn_blocking(move || change())
                .await
                .unwrap_or(false);
            if applied {
                known = Some(current);
            }
        }
    });
    WatchHandle { stop, task }
}
