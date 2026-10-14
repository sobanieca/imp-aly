use crate::error::{Error, Result};
use crate::fsutil::{read_json, write_json_atomic};
use crate::json::Object;
use crate::names::is_source;
use crate::paths::join;
use crate::token::{hex, random_bytes};

pub const SOURCE_FILE: &str = "source.json";

pub fn new_source() -> String {
    hex(&random_bytes(8))
}

pub fn open_source(data_dir: &str) -> Result<String> {
    let path = join(&[data_dir, SOURCE_FILE]);
    let Some(stored) = read_json(&path)? else {
        let source = new_source();
        write_json_atomic(&path, &Object::new().with("source", source.clone()).into())?;
        return Ok(source);
    };
    match stored.get_str("source") {
        Some(source) if is_source(source) => Ok(source.to_string()),
        _ => Err(Error::new(format!(
            "{path} does not hold a source id of 16 hex digits"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn a_data_folder_gets_one_random_source_id_and_a_damaged_id_stops_the_start() {
        let dir = TempDir::new();
        let source = open_source(&dir.path).unwrap();
        assert!(is_source(&source));
        assert_eq!(open_source(&dir.path).unwrap(), source);
        std::fs::write(dir.join(SOURCE_FILE), "{\"source\": \"x\"}").unwrap();
        assert!(open_source(&dir.path).is_err());
    }
}
