use crate::paths::join;
use crate::token::{hex, random_bytes};
use std::fs;

pub struct TempDir {
    pub path: String,
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl TempDir {
    pub fn new() -> Self {
        let base = std::env::temp_dir().to_string_lossy().into_owned();
        let path = join(&[&base, &format!("imp-aly-test-{}", hex(&random_bytes(8)))]);
        fs::create_dir_all(&path).expect("cannot create a temporary folder");
        TempDir { path }
    }

    pub fn join(&self, name: &str) -> String {
        join(&[&self.path, name])
    }

    pub fn keep(mut self) -> String {
        std::mem::take(&mut self.path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if !self.path.is_empty() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
