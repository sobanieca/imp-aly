use crate::json::{Value, format_number};

pub fn cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "-".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => format_number(*number),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(other) => crate::json::stringify(other),
    }
}

fn is_numeric(text: &str) -> bool {
    if text == "-" {
        return true;
    }
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction
            .is_none_or(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub fn format_table(columns: &[&str], rows: &[Value]) -> String {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|row| columns.iter().map(|column| cell(row.get(column))).collect())
        .collect();
    let widths: Vec<usize> = columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            cells
                .iter()
                .map(|line| line[index].chars().count())
                .fold(column.chars().count(), usize::max)
        })
        .collect();
    let numeric: Vec<bool> = (0..columns.len())
        .map(|index| !cells.is_empty() && cells.iter().all(|line| is_numeric(&line[index])))
        .collect();
    let format = |line: &[String]| {
        line.iter()
            .enumerate()
            .map(|(index, text)| {
                let pad = widths[index].saturating_sub(text.chars().count());
                if numeric[index] {
                    format!("{}{text}", " ".repeat(pad))
                } else {
                    format!("{text}{}", " ".repeat(pad))
                }
            })
            .collect::<Vec<_>>()
            .join("   ")
            .trim_end()
            .to_string()
    };
    let header: Vec<String> = columns.iter().map(|column| column.to_string()).collect();
    let mut out = vec![format(&header)];
    for line in &cells {
        out.push(format(line));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn a_table_pads_the_columns_and_aligns_the_numbers_right() {
        let rows =
            parse(r#"[{"page":"/","records":12},{"page":"/invoices","records":3,"visits":null}]"#)
                .unwrap();
        let rows = rows.as_array().unwrap();
        assert_eq!(
            format_table(&["page", "records", "visits"], rows),
            "page        records   visits\n/                12        -\n/invoices         3        -"
        );
    }

    #[test]
    fn a_table_of_many_rows_does_not_overflow_the_stack() {
        let rows: Vec<Value> = (0..200_000)
            .map(|at| crate::json::Object::new().with("n", at as i64).into())
            .collect();
        assert_eq!(format_table(&["n"], &rows).lines().count(), 200_001);
    }
}
