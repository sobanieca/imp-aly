use crate::error::{Error, Result};
use std::sync::Arc;

pub type Cell = Option<Arc<str>>;

pub fn encode_value(value: Option<&str>) -> &str {
    value.unwrap_or("")
}

pub fn decode_value(text: &str) -> Cell {
    if text.is_empty() {
        None
    } else {
        Some(Arc::from(text))
    }
}

pub fn split_lines(text: &str) -> Result<Vec<Cell>> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let Some(body) = text.strip_suffix('\n') else {
        return Err(Error::new("a column file does not end with a line break"));
    };
    Ok(body.split('\n').map(decode_value).collect())
}

pub fn parse_run(line: &str) -> Result<(u64, &str)> {
    let Some((count, value)) = line.split_once('\t') else {
        return Err(Error::new("a run line has no tab"));
    };
    let count = if !count.is_empty()
        && count.len() <= 16
        && count.bytes().all(|byte| byte.is_ascii_digit())
    {
        count.parse::<u64>().unwrap_or(0)
    } else {
        0
    };
    if count < 1 {
        return Err(Error::new("a run line has a wrong count"));
    }
    Ok((count, value))
}

pub fn decode_runs(text: &str, rows: u64) -> Result<Vec<Cell>> {
    let mut values = Vec::with_capacity(rows.min(1 << 24) as usize);
    let mut filled = 0u64;
    let mut rest = text;
    while !rest.is_empty() {
        let Some(end) = rest.find('\n') else {
            return Err(Error::new("a run file does not end with a line break"));
        };
        let line = &rest[..end];
        let (count, value) = parse_run(line)?;
        if filled + count > rows {
            return Err(Error::new("a run line has a wrong count"));
        }
        let cell = decode_value(value);
        for _ in 0..count {
            values.push(cell.clone());
        }
        filled += count;
        rest = &rest[end + 1..];
    }
    if filled != rows {
        return Err(Error::new(format!(
            "a run file holds {filled} rows, expected {rows}"
        )));
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(cells: &[Cell]) -> Vec<Option<&str>> {
        cells.iter().map(|cell| cell.as_deref()).collect()
    }

    #[test]
    fn runs_decode_with_nulls() {
        let values = decode_runs("2\ta\n1\t\n1\tb\n", 4).unwrap();
        assert_eq!(texts(&values), [Some("a"), Some("a"), None, Some("b")]);
    }

    #[test]
    fn decoding_checks_the_row_count() {
        assert!(decode_runs("2\ta\n", 3).is_err());
        assert!(decode_runs("2\ta\n", 1).is_err());
        assert!(decode_runs("0\ta\n", 0).is_err());
        assert!(decode_runs("2a\n", 2).is_err());
        assert!(decode_runs("2\ta", 2).is_err());
    }

    #[test]
    fn plain_column_lines_decode_empty_lines_as_null() {
        assert_eq!(
            texts(&split_lines("a\n\nb\n").unwrap()),
            [Some("a"), None, Some("b")]
        );
        assert!(split_lines("a").is_err());
        assert!(split_lines("").unwrap().is_empty());
    }
}
