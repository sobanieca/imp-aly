use std::collections::HashMap;
use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_safe_integer(&self) -> Option<i64> {
        match self {
            Value::Number(number) if is_safe_integer(*number) => Some(*number as i64),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object().and_then(|object| object.get(key))
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }
}

pub fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Value::String(text.to_string())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Value::String(text)
    }
}

impl From<&String> for Value {
    fn from(text: &String) -> Self {
        Value::String(text.clone())
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Value::Bool(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Self {
        Value::Number(value)
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Value::Number(value as f64)
    }
}

impl From<u64> for Value {
    fn from(value: u64) -> Self {
        Value::Number(value as f64)
    }
}

impl From<usize> for Value {
    fn from(value: usize) -> Self {
        Value::Number(value as f64)
    }
}

impl From<u32> for Value {
    fn from(value: u32) -> Self {
        Value::Number(f64::from(value))
    }
}

impl From<u16> for Value {
    fn from(value: u16) -> Self {
        Value::Number(f64::from(value))
    }
}

impl From<Object> for Value {
    fn from(object: Object) -> Self {
        Value::Object(object)
    }
}

impl<T: Into<Value>> From<Vec<T>> for Value {
    fn from(items: Vec<T>) -> Self {
        Value::Array(items.into_iter().map(Into::into).collect())
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(value: Option<T>) -> Self {
        value.map_or(Value::Null, Into::into)
    }
}

const INDEX_FROM: usize = 16;

#[derive(Clone, Debug, Default)]
pub struct Object {
    entries: Vec<(String, Value)>,
    index: Option<HashMap<String, usize>>,
}

impl PartialEq for Object {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}

impl Object {
    pub fn new() -> Self {
        Self::default()
    }

    fn position(&self, key: &str) -> Option<usize> {
        match &self.index {
            Some(index) => index.get(key).copied(),
            None => self.entries.iter().position(|(name, _)| name == key),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.position(key).map(|at| &self.entries[at].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.position(key).map(|at| &mut self.entries[at].1)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.position(key).is_some()
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<Value>) {
        let key = key.into();
        let value = value.into();
        if let Some(at) = self.position(&key) {
            self.entries[at].1 = value;
            return;
        }
        if let Some(index) = &mut self.index {
            index.insert(key.clone(), self.entries.len());
        }
        self.entries.push((key, value));
        if self.index.is_none() && self.entries.len() > INDEX_FROM {
            self.index = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(at, (name, _))| (name.clone(), at))
                    .collect(),
            );
        }
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.insert(key, value);
        self
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let at = self.position(key)?;
        let (_, value) = self.entries.remove(at);
        if self.index.is_some() {
            self.index = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(at, (name, _))| (name.clone(), at))
                    .collect(),
            );
        }
        Some(value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl FromIterator<(String, Value)> for Object {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        let mut object = Object::new();
        for (key, value) in iter {
            object.insert(key, value);
        }
        object
    }
}

pub fn format_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number == 0.0 {
        return "0".to_string();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    let sign = if number < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let count = digits.len() as i32;
    let point = exponent + 1;
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let power = point - 1;
        let power = if power >= 0 {
            format!("+{power}")
        } else {
            power.to_string()
        };
        if count == 1 {
            format!("{digits}e{power}")
        } else {
            format!("{}.{}e{power}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None, 0);
    out
}

pub fn pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(2), 0);
    out
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(width) = indent {
        out.push('\n');
        for _ in 0..width * depth {
            out.push(' ');
        }
    }
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) if number.is_finite() => out.push_str(&format_number(*number)),
        Value::Number(_) => out.push_str("null"),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(object) => {
            if object.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (at, (key, item)) in object.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

pub fn quote(text: &str) -> String {
    let mut out = String::new();
    write_string(&mut out, text);
    out
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn parse(text: &str) -> Result<Value, String> {
    let mut parser = Parser {
        text,
        bytes: text.as_bytes(),
        pos: 0,
    };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.pos < parser.bytes.len() {
        return Err(parser.unexpected());
    }
    Ok(value)
}

const MAX_DEPTH: usize = 512;

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn unexpected(&self) -> String {
        match self
            .text
            .get(self.pos..)
            .and_then(|rest| rest.chars().next())
        {
            Some(c) => format!("Unexpected token '{c}' in JSON at position {}", self.pos),
            None => "Unexpected end of JSON input".to_string(),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.unexpected())
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err("JSON is nested too deeply".to_string());
        }
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.unexpected()),
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, String> {
        for &byte in word.as_bytes() {
            if self.peek() != Some(byte) {
                return Err(self.unexpected());
            }
            self.pos += 1;
        }
        Ok(value)
    }

    fn object(&mut self, depth: usize) -> Result<Value, String> {
        self.pos += 1;
        let mut object = Object::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(object));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(self.unexpected());
            }
            let key = self.string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            self.skip_whitespace();
            let value = self.value(depth + 1)?;
            object.insert(key, value);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(object));
                }
                _ => return Err(self.unexpected()),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, String> {
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.unexpected()),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self
            .text
            .get(self.pos..self.pos + 4)
            .filter(|digits| digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| "Bad Unicode escape in JSON".to_string())?;
        self.pos += 4;
        u32::from_str_radix(digits, 16).map_err(|error| error.to_string())
    }

    fn string(&mut self) -> Result<String, String> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let start = self.pos;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            out.push_str(&self.text[start..self.pos]);
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let escape = self.peek().ok_or_else(|| self.unexpected())?;
                    self.pos += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let c = if (0xD800..0xDC00).contains(&unit)
                                && self.bytes.get(self.pos..self.pos + 2) == Some(b"\\u")
                            {
                                let saved = self.pos;
                                self.pos += 2;
                                let low = self.hex4()?;
                                if (0xDC00..0xE000).contains(&low) {
                                    char::from_u32(
                                        0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00),
                                    )
                                } else {
                                    self.pos = saved;
                                    None
                                }
                            } else {
                                char::from_u32(unit)
                            };
                            out.push(c.unwrap_or('\u{FFFD}'));
                        }
                        _ => {
                            self.pos -= 1;
                            return Err(self.unexpected());
                        }
                    }
                }
                _ => return Err(self.unexpected()),
            }
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.unexpected()),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.unexpected());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.unexpected());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        self.text[start..self.pos]
            .parse::<f64>()
            .map(Value::Number)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_like_javascript() {
        let cases = [
            (0.0, "0"),
            (1.0, "1"),
            (1.5, "1.5"),
            (-2.25, "-2.25"),
            (100.0, "100"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (1_759_000_000_000.0, "1759000000000"),
        ];
        for (number, expected) in cases {
            assert_eq!(format_number(number), expected, "{number}");
        }
    }

    #[test]
    fn keeps_the_order_of_the_keys() {
        let text = r#"{"b":1,"a":[true,false,null,"x\n\"y\u0001"],"2":{},"1":-1.5e3}"#;
        let value = parse(text).unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"b":1,"a":[true,false,null,"x\n\"y\u0001"],"2":{},"1":-1500}"#
        );
    }

    #[test]
    fn pretty_prints_like_stringify_with_two_spaces() {
        let value = parse(r#"{"a":[1,{"b":[]}],"c":{}}"#).unwrap();
        assert_eq!(
            pretty(&value),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": []\n    }\n  ],\n  \"c\": {}\n}"
        );
    }

    #[test]
    fn a_large_object_finds_its_keys() {
        let mut object = Object::new();
        for at in 0..100 {
            object.insert(format!("k{at}"), at as i64);
        }
        object.insert("k5", 500_i64);
        assert_eq!(object.get("k5"), Some(&Value::Number(500.0)));
        assert_eq!(object.get("k99"), Some(&Value::Number(99.0)));
        assert_eq!(object.len(), 100);
        object.remove("k0");
        assert_eq!(object.get("k99"), Some(&Value::Number(99.0)));
    }

    #[test]
    fn rejects_invalid_json_and_deep_nesting() {
        for text in [
            "",
            "{",
            "[1,]",
            "{\"a\" 1}",
            "01",
            "1.",
            "tru",
            "\"a",
            "{} x",
        ] {
            assert!(parse(text).is_err(), "{text}");
        }
        assert!(parse(&"[".repeat(10_000)).is_err());
    }
}
