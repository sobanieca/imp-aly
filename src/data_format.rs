use crate::VERSION;
use crate::error::{Error, Result};
use crate::fsutil::{read_json, write_json_atomic};
use crate::json::{Object, Value, stringify};
use crate::paths::join;

pub const DATA_FORMAT: u32 = 3;

pub const FORMAT_FILE: &str = "format.json";

pub fn check_data_format(data_dir: &str) -> Result<()> {
    let path = join(&[data_dir, FORMAT_FILE]);
    let Some(stored) = read_json(&path)? else {
        return write_json_atomic(&path, &Object::new().with("format", DATA_FORMAT).into());
    };
    let format = stored.get("format").cloned().unwrap_or(Value::Null);
    if format.as_f64() == Some(f64::from(DATA_FORMAT)) {
        return Ok(());
    }
    Err(Error::new(format!(
        "the data folder {data_dir} has the data format {}, and imp-aly {VERSION} reads only the format {DATA_FORMAT} - install a version of imp-aly that reads it",
        stringify(&format)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn the_data_folder_keeps_its_format_and_refuses_another_one() {
        let dir = TempDir::new();
        check_data_format(&dir.path).unwrap();
        check_data_format(&dir.path).unwrap();
        std::fs::write(dir.join(FORMAT_FILE), "{\"format\": 2}\n").unwrap();
        let error = check_data_format(&dir.path).unwrap_err();
        assert!(error.message.contains("has the data format 2"));
    }
}
