use std::env;

pub fn join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    let mut out = String::with_capacity(joined.len());
    let mut last_slash = false;
    for c in joined.chars() {
        if c == '/' && last_slash {
            continue;
        }
        last_slash = c == '/';
        out.push(c);
    }
    out
}

pub fn dirname(path: &str) -> String {
    let trimmed = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    match trimmed.rfind('/') {
        None => ".".to_string(),
        Some(0) => "/".to_string(),
        Some(at) => trimmed[..at].to_string(),
    }
}

pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn home() -> String {
    env::var("HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| ".".to_string())
}

pub fn expand_home(path: &str) -> String {
    if path == "~" {
        return home();
    }
    match path.strip_prefix("~/") {
        Some(rest) => join(&[&home(), rest]),
        None => path.to_string(),
    }
}

pub fn cwd() -> String {
    env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

pub fn absolute_path(path: &str) -> String {
    let expanded = expand_home(path);
    if expanded.starts_with('/') {
        expanded
    } else {
        join(&[&cwd(), &expanded])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_and_splits_paths() {
        assert_eq!(join(&["/a/", "b", "", "c"]), "/a/b/c");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(basename("/usr/local/bin/imp-aly"), "imp-aly");
    }
}
