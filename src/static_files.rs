use crate::http::Response;
use crate::url::strict_decode;
use std::borrow::Cow;
use std::path::PathBuf;

include!(concat!(env!("OUT_DIR"), "/console_files.rs"));

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

#[derive(Clone)]
pub enum Files {
    Embedded,
    Folder(PathBuf),
}

impl Files {
    pub fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        match self {
            Files::Embedded => CONSOLE_FILES
                .iter()
                .find(|(name, _)| *name == path)
                .map(|(_, bytes)| Cow::Borrowed(*bytes)),
            Files::Folder(root) => {
                let full = root.join(path.trim_start_matches('/'));
                if !full.starts_with(root) {
                    return None;
                }
                match std::fs::metadata(&full) {
                    Ok(meta) if meta.is_file() => std::fs::read(&full).ok().map(Cow::Owned),
                    _ => None,
                }
            }
        }
    }

    pub fn is_built(&self) -> bool {
        self.get("/index.html").is_some()
    }

    pub fn describe(&self) -> String {
        match self {
            Files::Embedded => "this binary".to_string(),
            Files::Folder(root) => root.display().to_string(),
        }
    }
}

fn content_type(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or("");
    let extension = match name.rfind('.') {
        Some(at) if at > 0 => name[at + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn has_extension(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("");
    name.rfind('.').is_some_and(|at| at > 0)
}

fn not_found() -> Response {
    Response::text(404, "not found", "text/plain; charset=utf-8")
        .header("cache-control", "no-cache")
}

fn file_response(bytes: Cow<'static, [u8]>, path: &str) -> Response {
    let cache = if path.starts_with("/chunks/") {
        IMMUTABLE
    } else {
        "no-cache"
    };
    Response::new(200)
        .header("content-type", content_type(path))
        .header("cache-control", cache)
        .bytes(bytes.into_owned())
}

pub fn serve_ui(files: &Files, pathname: &str) -> Response {
    let Some(path) = strict_decode(pathname) else {
        return not_found();
    };
    if path.contains('\0') || path.split('/').skip(1).any(|part| part.starts_with('.')) {
        return not_found();
    }
    if path != "/" && !path.ends_with('/') {
        if let Some(bytes) = files.get(&path) {
            return file_response(bytes, &path);
        }
        if path.starts_with("/chunks/") || has_extension(&path) {
            return not_found();
        }
    }
    match files.get("/index.html") {
        Some(bytes) => file_response(bytes, "/index.html"),
        None => not_found(),
    }
}
