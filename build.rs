use std::fs;
use std::path::{Path, PathBuf};

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("console").join("dist");
    println!("cargo:rerun-if-changed=console");
    println!("cargo:rerun-if-changed=console/dist");
    let mut files = Vec::new();
    collect(&dist, &mut files);
    files.sort();
    let mut code = String::from("pub static CONSOLE_FILES: &[(&str, &[u8])] = &[\n");
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
        let relative = file
            .strip_prefix(&dist)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        code.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            format!("/{relative}"),
            file.display().to_string()
        ));
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("console_files.rs");
    fs::write(out, code).unwrap();
}
