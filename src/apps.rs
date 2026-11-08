use crate::app_build::{FetchFile, Lists, fetch_build, folder_url};
use crate::days::{iso, now_ms};
use crate::error::{Error, Result};
use crate::fsutil::{read_json, write_json_atomic};
use crate::json::{Object, Value, stringify};
use crate::names::{MAX_ORIGINS, MAX_SEGMENTS, is_app_name, is_segment_name, reserved_names};
use crate::origins::{origin_of, parse_origin};
use crate::paths::join;
use crate::token::sha256_hex;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

const REJECTION_KINDS_LIMIT: usize = 50;

fn app_error(message: impl Into<String>) -> Error {
    Error::status(400, message)
}

pub fn validate_segments(segments: Option<&Value>) -> Result<Vec<String>> {
    let Some(segments) = segments else {
        return Ok(Vec::new());
    };
    let Value::Array(list) = segments else {
        return Err(app_error("segments is a list of names, like [\"plan\"]"));
    };
    if list.len() > MAX_SEGMENTS {
        return Err(app_error(format!(
            "an app has at most {MAX_SEGMENTS} segments"
        )));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for segment in list {
        let text = match segment {
            Value::String(text) if is_segment_name(text) => text,
            other => {
                let shown = match other {
                    Value::String(text) => text.clone(),
                    other => stringify(other),
                };
                return Err(app_error(format!(
                    "segment \"{shown}\" is not a name of 1 to 32 letters and digits that starts with a letter"
                )));
            }
        };
        let lower = text.to_lowercase();
        if reserved_names().any(|name| name.to_lowercase() == lower) {
            return Err(app_error(format!("segment \"{text}\" is a reserved name")));
        }
        if !seen.insert(lower) {
            return Err(app_error(format!("segment \"{text}\" is given twice")));
        }
        out.push(text.clone());
    }
    Ok(out)
}

const ORIGINS_HINT: &str = "origins is a list of browser origins, like [\"https://myapp.example\"]";

pub fn validate_origins(origins: Option<&Value>, app_url: &str) -> Result<BTreeSet<String>> {
    let Some(origins) = origins else {
        return origin_of(app_url)
            .map(|origin| BTreeSet::from([origin]))
            .ok_or_else(|| app_error(format!("give the origins of the app: {ORIGINS_HINT}")));
    };
    let Value::Array(list) = origins else {
        return Err(app_error(ORIGINS_HINT));
    };
    if list.is_empty() {
        return Err(app_error(format!(
            "give at least one origin: {ORIGINS_HINT}"
        )));
    }
    if list.len() > MAX_ORIGINS {
        return Err(app_error(format!(
            "an app has at most {MAX_ORIGINS} origins"
        )));
    }
    let mut out = BTreeSet::new();
    for origin in list {
        let Value::String(text) = origin else {
            return Err(app_error(ORIGINS_HINT));
        };
        out.insert(parse_origin(text).map_err(app_error)?);
    }
    Ok(out)
}

#[derive(Clone)]
pub struct App {
    id: u64,
    pub name: String,
    pub app_url: String,
    pub lists: Arc<Lists>,
    pub segments: Arc<Vec<String>>,
    pub origins: Arc<BTreeSet<String>>,
    created_at: Option<String>,
    build_updated_at: Option<String>,
    build_error: Option<String>,
    accepted: u64,
    rejected: u64,
    rejections: Vec<(String, u64)>,
}

fn strings(values: &BTreeSet<String>) -> Value {
    Value::Array(values.iter().map(Value::from).collect())
}

fn string_list(values: &[String]) -> Value {
    Value::Array(values.iter().map(Value::from).collect())
}

fn sorted(values: &[String]) -> Vec<String> {
    let mut copy = values.to_vec();
    copy.sort();
    copy
}

impl App {
    fn stored(&self) -> Value {
        Object::new()
            .with("appUrl", self.app_url.clone())
            .with("pages", strings(&self.lists.pages))
            .with("zones", strings(&self.lists.zones))
            .with("outcomes", strings(&self.lists.outcomes))
            .with("segments", string_list(&self.segments))
            .with("origins", strings(&self.origins))
            .with("createdAt", self.created_at.clone())
            .with("buildUpdatedAt", self.build_updated_at.clone())
            .with("buildError", self.build_error.clone())
            .into()
    }

    pub fn describe(&self) -> Value {
        let rejections: Object = self
            .rejections
            .iter()
            .map(|(problem, count)| (problem.clone(), Value::from(*count)))
            .collect();
        Object::new()
            .with("name", self.name.clone())
            .with("appUrl", self.app_url.clone())
            .with("pages", strings(&self.lists.pages))
            .with("zones", strings(&self.lists.zones))
            .with("outcomes", strings(&self.lists.outcomes))
            .with("segments", string_list(&self.segments))
            .with("origins", strings(&self.origins))
            .with("createdAt", self.created_at.clone())
            .with("buildUpdatedAt", self.build_updated_at.clone())
            .with("buildError", self.build_error.clone())
            .with("accepted", self.accepted)
            .with("rejected", self.rejected)
            .with("rejections", rejections)
            .into()
    }

    pub fn config(&self) -> String {
        let text = stringify(
            &Object::new()
                .with("pages", strings(&self.lists.pages))
                .with("zones", strings(&self.lists.zones))
                .with("outcomes", strings(&self.lists.outcomes))
                .with("segments", string_list(&sorted(&self.segments)))
                .into(),
        );
        sha256_hex(text.as_bytes())[..16].to_string()
    }
}

fn read_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn optional_text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

pub struct Rules {
    pub lists: Arc<Lists>,
    pub segments: Arc<Vec<String>>,
}

pub struct Apps {
    path: String,
    state: Mutex<Vec<App>>,
    save_lock: Mutex<()>,
    fetch_file: FetchFile,
    next_id: AtomicU64,
}

impl Apps {
    pub fn open(data_dir: &str, fetch_file: FetchFile) -> Result<Apps> {
        let path = join(&[data_dir, "apps.json"]);
        let stored = read_json(&path)?;
        let apps = Apps {
            path,
            state: Mutex::new(Vec::new()),
            save_lock: Mutex::new(()),
            fetch_file,
            next_id: AtomicU64::new(1),
        };
        if let Some(Value::Object(entries)) = stored.as_ref().and_then(|value| value.get("apps")) {
            let mut state = apps.lock();
            for (name, value) in entries.iter() {
                let Some(app_url) = optional_text(value.get("appUrl")) else {
                    continue;
                };
                if !is_app_name(name) {
                    continue;
                }
                let lists = Lists {
                    pages: read_strings(value.get("pages")).into_iter().collect(),
                    zones: read_strings(value.get("zones")).into_iter().collect(),
                    outcomes: read_strings(value.get("outcomes")).into_iter().collect(),
                };
                state.push(App {
                    id: apps.next_id.fetch_add(1, Ordering::Relaxed),
                    name: name.clone(),
                    app_url,
                    lists: Arc::new(lists),
                    segments: Arc::new(read_strings(value.get("segments"))),
                    origins: Arc::new(read_strings(value.get("origins")).into_iter().collect()),
                    created_at: optional_text(value.get("createdAt")),
                    build_updated_at: optional_text(value.get("buildUpdatedAt")),
                    build_error: optional_text(value.get("buildError")),
                    accepted: 0,
                    rejected: 0,
                    rejections: Vec::new(),
                });
            }
        }
        Ok(apps)
    }

    fn lock(&self) -> MutexGuard<'_, Vec<App>> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn save(&self) -> Result<()> {
        let _guard = self
            .save_lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let snapshot: Object = self
            .lock()
            .iter()
            .map(|app| (app.name.clone(), app.stored()))
            .collect();
        write_json_atomic(&self.path, &Object::new().with("apps", snapshot).into())
    }

    pub fn rules(&self, name: &str) -> Option<Rules> {
        self.lock()
            .iter()
            .find(|app| app.name == name)
            .map(|app| Rules {
                lists: app.lists.clone(),
                segments: app.segments.clone(),
            })
    }

    pub fn origins(&self, name: &str) -> Option<Arc<BTreeSet<String>>> {
        self.lock()
            .iter()
            .find(|app| app.name == name)
            .map(|app| app.origins.clone())
    }

    pub fn config(&self, name: &str) -> Option<String> {
        self.lock()
            .iter()
            .find(|app| app.name == name)
            .map(App::config)
    }

    pub fn count(&self) -> usize {
        self.lock().len()
    }

    pub fn list(&self) -> Value {
        Value::Array(self.lock().iter().map(App::describe).collect())
    }

    fn missing(name: &str) -> Error {
        Error::status(404, format!("no app \"{name}\" is registered"))
    }

    pub fn describe(&self, name: &str) -> Result<Value> {
        self.lock()
            .iter()
            .find(|app| app.name == name)
            .map(App::describe)
            .ok_or_else(|| Self::missing(name))
    }

    fn read_app_url(body: &Object) -> Result<String> {
        body.get("appUrl")
            .and_then(Value::as_str)
            .and_then(folder_url)
            .ok_or_else(|| {
                app_error(
                    "appUrl is the http or https URL of the folder of the build, like https://myapp.example/",
                )
            })
    }

    pub fn put(&self, name: &str, body: &Value) -> Result<Value> {
        if !is_app_name(name) {
            return Err(app_error(format!(
                "\"{name}\" is not an app name - use 1 to 63 lowercase letters, digits and \"-\", like myapp"
            )));
        }
        let Value::Object(body) = body else {
            return Err(app_error(
                "the body is an object, like {\"appUrl\": \"https://myapp.example/\"}",
            ));
        };
        let unknown: Vec<&str> = body
            .keys()
            .filter(|key| !["appUrl", "segments", "origins"].contains(&key.as_str()))
            .map(String::as_str)
            .collect();
        if !unknown.is_empty() {
            return Err(app_error(format!("unknown fields: {}", unknown.join(", "))));
        }
        let segments = validate_segments(body.get("segments"))?;
        let app_url = Self::read_app_url(body)?;
        let origins = validate_origins(body.get("origins"), &app_url)?;
        let lists = fetch_build(&app_url, &self.fetch_file)
            .map_err(|error| Error::status(422, format!("the build could not be read: {error}")))?;
        let now = iso(now_ms());
        let described = {
            let mut state = self.lock();
            let previous = state.iter().position(|app| app.name == name);
            let mut app = App {
                id: self.next_id.fetch_add(1, Ordering::Relaxed),
                name: name.to_string(),
                app_url,
                lists: Arc::new(lists),
                segments: Arc::new(segments),
                origins: Arc::new(origins),
                created_at: Some(now.clone()),
                build_updated_at: Some(now),
                build_error: None,
                accepted: 0,
                rejected: 0,
                rejections: Vec::new(),
            };
            match previous {
                Some(at) => {
                    let old = &state[at];
                    app.created_at = old.created_at.clone().or(app.created_at);
                    app.accepted = old.accepted;
                    app.rejected = old.rejected;
                    app.rejections = old.rejections.clone();
                    let described = app.describe();
                    state[at] = app;
                    described
                }
                None => {
                    let described = app.describe();
                    state.push(app);
                    described
                }
            }
        };
        self.save()?;
        Ok(described)
    }

    pub fn remove(&self, name: &str) -> Result<()> {
        {
            let mut state = self.lock();
            let at = state
                .iter()
                .position(|app| app.name == name)
                .ok_or_else(|| Self::missing(name))?;
            state.remove(at);
        }
        self.save()
    }

    fn reread(&self, id: u64, app_url: &str) -> bool {
        let result = fetch_build(app_url, &self.fetch_file);
        let mut state = self.lock();
        let Some(app) = state.iter_mut().find(|app| app.id == id) else {
            return false;
        };
        match result {
            Ok(lists) => {
                app.lists = Arc::new(lists);
                app.build_updated_at = Some(iso(now_ms()));
                app.build_error = None;
            }
            Err(error) => app.build_error = Some(error),
        }
        true
    }

    pub fn refresh(&self, name: &str) -> Result<Value> {
        let (id, app_url) = {
            let state = self.lock();
            let app = state
                .iter()
                .find(|app| app.name == name)
                .ok_or_else(|| Self::missing(name))?;
            (app.id, app.app_url.clone())
        };
        if self.reread(id, &app_url) {
            self.save()?;
        }
        let state = self.lock();
        state
            .iter()
            .find(|app| app.id == id)
            .map(App::describe)
            .ok_or_else(|| Self::missing(name))
    }

    pub fn refresh_all(&self) -> Result<()> {
        let targets: Vec<(u64, String)> = self
            .lock()
            .iter()
            .map(|app| (app.id, app.app_url.clone()))
            .collect();
        for (id, url) in targets {
            self.reread(id, &url);
        }
        self.save()
    }

    pub fn count_accepted(&self, name: &str, count: u64) {
        if let Some(app) = self.lock().iter_mut().find(|app| app.name == name) {
            app.accepted += count;
        }
    }

    pub fn count_rejected(&self, name: &str, problem: &str) {
        if let Some(app) = self.lock().iter_mut().find(|app| app.name == name) {
            app.rejected += 1;
            if let Some(entry) = app.rejections.iter_mut().find(|(kind, _)| kind == problem) {
                entry.1 += 1;
            } else if app.rejections.len() < REJECTION_KINDS_LIMIT {
                app.rejections.push((problem.to_string(), 1));
            }
        }
    }
}
