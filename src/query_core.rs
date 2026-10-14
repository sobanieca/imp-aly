use crate::days::{day_of, is_day, month_of, week_of};
use crate::error::Error;
use crate::json::{Object, Value, is_safe_integer};
use crate::names::{BASE_COLUMNS, is_app_name, is_reserved, is_segment_name};
use std::collections::{HashMap, HashSet};

pub const DEFAULT_LIMIT: u64 = 1_000;

pub const MAX_LIMIT: u64 = 100_000;

pub const MAX_GROUPS: usize = 100_000;

const MAX_WHERE_VALUES: usize = 1_000;

const TIME_FIELDS: [&str; 3] = ["day", "week", "month"];

const MEASURES: [&str; 2] = ["records", "visits"];

const QUERY_KEYS: [&str; 7] = ["app", "from", "to", "where", "groupBy", "measures", "limit"];

pub fn query_error(message: impl Into<String>) -> Error {
    Error::status(400, message)
}

fn dimensions() -> impl Iterator<Item = &'static str> {
    BASE_COLUMNS
        .iter()
        .copied()
        .filter(|column| *column != "at")
}

fn is_dimension(field: &str) -> bool {
    dimensions().any(|dimension| dimension == field)
        || (is_segment_name(field) && !is_reserved(field))
}

fn dimension_hint() -> String {
    format!(
        "{} or a segment name",
        dimensions().collect::<Vec<_>>().join(", ")
    )
}

pub fn is_time_field(field: &str) -> bool {
    TIME_FIELDS.contains(&field)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Filter {
    pub field: String,
    pub values: HashSet<Option<String>>,
}

impl Filter {
    pub fn matches(&self, value: Option<&str>) -> bool {
        self.values.contains(&value.map(str::to_string))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    pub app: String,
    pub from: String,
    pub to: String,
    pub filters: Vec<Filter>,
    pub group_by: Vec<String>,
    pub measures: Vec<String>,
    pub limit: u64,
}

impl Query {
    pub fn wants_visits(&self) -> bool {
        self.measures.iter().any(|measure| measure == "visits")
    }
}

fn day_field(value: Option<&Value>) -> Option<Option<&Value>> {
    match value {
        None | Some(Value::Null) => None,
        Some(other) => Some(Some(other)),
    }
}

pub fn parse_query(input: &Value, now: i64) -> Result<Query, Error> {
    let Value::Object(input) = input else {
        return Err(query_error(
            "the query is a JSON object, like {\"app\": \"myapp\"}",
        ));
    };
    let unknown: Vec<&str> = input
        .keys()
        .filter(|key| !QUERY_KEYS.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(query_error(format!(
            "unknown query fields: {} - use {}",
            unknown.join(", "),
            QUERY_KEYS.join(", ")
        )));
    }
    let app = match input.get("app") {
        Some(Value::String(app)) if is_app_name(app) => app.clone(),
        _ => return Err(query_error("app is the name of a registered app")),
    };
    let today = Value::String(day_of(now));
    let to_value = day_field(input.get("to"))
        .or_else(|| day_field(input.get("from")))
        .flatten()
        .unwrap_or(&today);
    let from_value = day_field(input.get("from")).flatten().unwrap_or(to_value);
    let from = match from_value {
        Value::String(day) if is_day(day) => day.clone(),
        _ => return Err(query_error("from is a day like 2026-10-01")),
    };
    let to = match to_value {
        Value::String(day) if is_day(day) => day.clone(),
        _ => return Err(query_error("to is a day like 2026-10-01")),
    };
    if from > to {
        return Err(query_error("from is after to"));
    }
    let mut filters = Vec::new();
    if let Some(conditions) = input.get("where") {
        let Value::Object(conditions) = conditions else {
            return Err(query_error("where is an object, like {\"type\": \"page\"}"));
        };
        for (field, value) in conditions.iter() {
            if !is_dimension(field) {
                return Err(query_error(format!(
                    "where \"{field}\" is not a dimension - use {}",
                    dimension_hint()
                )));
            }
            let items: Vec<&Value> = match value {
                Value::Array(items) => items.iter().collect(),
                other => vec![other],
            };
            if items.is_empty() || items.len() > MAX_WHERE_VALUES {
                return Err(query_error(format!(
                    "where \"{field}\" takes 1 to {MAX_WHERE_VALUES} values"
                )));
            }
            let mut values = HashSet::new();
            for item in items {
                match item {
                    Value::Null => {
                        values.insert(None);
                    }
                    Value::String(text) if text.is_empty() => {
                        values.insert(None);
                    }
                    Value::String(text) => {
                        values.insert(Some(text.clone()));
                    }
                    _ => {
                        return Err(query_error(format!(
                            "where \"{field}\" takes a text, null, or a list of them"
                        )));
                    }
                }
            }
            filters.push(Filter {
                field: field.clone(),
                values,
            });
        }
    }
    let group_by_hint = "groupBy is a list of up to 8 dimensions, like [\"day\", \"page\"]";
    let group_by = match input.get("groupBy") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= 8 => {
            let mut fields = Vec::new();
            for item in items {
                let valid = item
                    .as_str()
                    .is_some_and(|field| is_time_field(field) || is_dimension(field));
                if !valid {
                    let shown = match item {
                        Value::String(text) => text.clone(),
                        other => crate::json::stringify(other),
                    };
                    return Err(query_error(format!(
                        "groupBy \"{shown}\" is not a dimension - use day, week, month, {}",
                        dimension_hint()
                    )));
                }
                fields.push(item.as_str().unwrap_or("").to_string());
            }
            fields
        }
        Some(_) => return Err(query_error(group_by_hint)),
    };
    let unique: HashSet<&String> = group_by.iter().collect();
    if unique.len() != group_by.len() {
        return Err(query_error("groupBy names a field twice"));
    }
    if group_by.iter().filter(|field| is_time_field(field)).count() > 1 {
        return Err(query_error("groupBy takes one of day, week and month"));
    }
    let measures_hint = "measures is a list of records and visits, like [\"records\", \"visits\"]";
    let measures = match input.get("measures") {
        None | Some(Value::Null) => vec!["records".to_string()],
        Some(Value::Array(items)) if !items.is_empty() => {
            let mut measures = Vec::new();
            for item in items {
                match item {
                    Value::String(measure) if MEASURES.contains(&measure.as_str()) => {
                        measures.push(measure.clone());
                    }
                    _ => return Err(query_error(measures_hint)),
                }
            }
            measures
        }
        Some(_) => return Err(query_error(measures_hint)),
    };
    let unique: HashSet<&String> = measures.iter().collect();
    if unique.len() != measures.len() {
        return Err(query_error("measures names one twice"));
    }
    let limit = match input.get("limit") {
        None | Some(Value::Null) => DEFAULT_LIMIT,
        Some(Value::Number(limit))
            if is_safe_integer(*limit) && *limit >= 1.0 && *limit <= MAX_LIMIT as f64 =>
        {
            *limit as u64
        }
        Some(_) => {
            return Err(query_error(format!(
                "limit is a whole number from 1 to {MAX_LIMIT}"
            )));
        }
    };
    Ok(Query {
        app,
        from,
        to,
        filters,
        group_by,
        measures,
        limit,
    })
}

const VISIT_BLIND_DIMENSIONS: [&str; 2] = ["zone", "name"];

pub fn can_use_summary(query: &Query) -> bool {
    let fields: Vec<&str> = query
        .filters
        .iter()
        .map(|filter| filter.field.as_str())
        .chain(query.group_by.iter().map(String::as_str))
        .collect();
    if fields.contains(&"visit") {
        return false;
    }
    if !query.wants_visits() {
        return true;
    }
    !fields
        .iter()
        .any(|field| VISIT_BLIND_DIMENSIONS.contains(field))
}

pub fn time_field_of(group_by: &[String]) -> Option<&str> {
    group_by
        .iter()
        .find(|field| is_time_field(field))
        .map(String::as_str)
}

pub struct GroupParts {
    pub fields: Vec<String>,
    pub time: Vec<Option<String>>,
}

pub fn group_parts(group_by: &[String], day: &str) -> GroupParts {
    GroupParts {
        fields: group_by
            .iter()
            .filter(|field| !is_time_field(field))
            .cloned()
            .collect(),
        time: group_by
            .iter()
            .map(|field| match field.as_str() {
                "day" => Some(day.to_string()),
                "week" => Some(week_of(day)),
                "month" => Some(month_of(day)),
                _ => None,
            })
            .collect(),
    }
}

pub type Parts = Vec<Option<String>>;

pub fn key_of(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .map(|part| part.as_deref().unwrap_or("\u{1}"))
        .collect::<Vec<_>>()
        .join("\u{0}")
}

#[derive(Clone, Debug)]
pub struct Group {
    pub key: String,
    pub parts: Parts,
    pub records: u64,
    pub visits: u64,
    pub stamp: u64,
}

#[derive(Default)]
pub struct Aggregate {
    pub groups: Vec<Group>,
    index: HashMap<String, usize>,
    pub stamp: u64,
}

impl Aggregate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn group(&mut self, parts: Parts) -> usize {
        let key = key_of(&parts);
        if let Some(at) = self.index.get(&key) {
            return *at;
        }
        let at = self.groups.len();
        self.index.insert(key.clone(), at);
        self.groups.push(Group {
            key,
            parts,
            records: 0,
            visits: 0,
            stamp: 0,
        });
        at
    }

    pub fn merge(&mut self, parts: Parts, records: u64, visits: u64) {
        let at = self.group(parts);
        self.groups[at].records += records;
        self.groups[at].visits += visits;
    }

    pub fn len(&self) -> usize {
        self.groups.len()
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

fn count_of(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_safe_integer)
        .map_or(0, |count| count.max(0) as u64)
}

fn parts_of(value: Option<&Value>) -> Parts {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::String(text) => Some(text.clone()),
                    Value::Null => None,
                    other => Some(crate::json::stringify(other)),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_count(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_safe_integer)
        .is_some_and(|count| count >= 0)
}

pub fn is_query_answer(answer: &Value) -> bool {
    let Value::Object(answer) = answer else {
        return false;
    };
    let groups_ok = answer
        .get("groups")
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().all(|group| {
                group.as_object().is_some()
                    && group.get("by").and_then(Value::as_array).is_some()
                    && is_count(group.get("records"))
            })
        });
    answer.get("days").and_then(Value::as_array).is_some()
        && groups_ok
        && answer
            .get("skippedDays")
            .and_then(Value::as_array)
            .is_some()
        && is_count(answer.get("scanned"))
        && is_count(answer.get("matched"))
}

pub struct ServerAnswer {
    pub server: String,
    pub answer: Value,
}

pub fn finalize_query(query: &Query, answers: &[ServerAnswer]) -> Object {
    let mut aggregate = Aggregate::new();
    let mut days: HashSet<String> = HashSet::new();
    let mut servers = Vec::new();
    let mut skipped_days = Vec::new();
    let mut scanned = 0u64;
    let mut matched = 0u64;
    for ServerAnswer { server, answer } in answers {
        let day_list = answer
            .get("days")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for day in &day_list {
            if let Some(day) = day.as_str() {
                days.insert(day.to_string());
            }
        }
        for group in answer
            .get("groups")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            aggregate.merge(
                parts_of(group.get("by")),
                count_of(group.get("records")),
                count_of(group.get("visits")),
            );
        }
        let answer_scanned = count_of(answer.get("scanned"));
        let answer_matched = count_of(answer.get("matched"));
        scanned += answer_scanned;
        matched += answer_matched;
        servers.push(Value::Object(
            Object::new()
                .with("server", server.clone())
                .with("days", day_list.len())
                .with(
                    "summaryDays",
                    answer.get("summaryDays").cloned().unwrap_or(Value::Null),
                )
                .with("scanned", answer_scanned)
                .with("matched", answer_matched),
        ));
        for entry in answer
            .get("skippedDays")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let mut item = Object::new().with("server", server.clone());
            if let Some(entry) = entry.as_object() {
                for (key, value) in entry.iter() {
                    item.insert(key.clone(), value.clone());
                }
            }
            skipped_days.push(Value::Object(item));
        }
    }
    if query.group_by.is_empty() && aggregate.is_empty() {
        aggregate.group(Vec::new());
    }
    let first = query.measures.first().map_or("records", String::as_str);
    let mut rows: Vec<(&Group, u64)> = aggregate
        .groups
        .iter()
        .map(|group| {
            let value = if first == "visits" {
                group.visits
            } else {
                group.records
            };
            (group, value)
        })
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.key.cmp(&b.0.key)));
    let truncated = rows.len() as u64 > query.limit;
    let rows: Vec<Value> = rows
        .into_iter()
        .take(query.limit as usize)
        .map(|(group, _)| {
            let mut row = Object::new();
            for (index, field) in query.group_by.iter().enumerate() {
                row.insert(field.clone(), group.parts.get(index).cloned().flatten());
            }
            for measure in &query.measures {
                let value = if measure == "visits" {
                    group.visits
                } else {
                    group.records
                };
                row.insert(measure.clone(), value);
            }
            Value::Object(row)
        })
        .collect();
    Object::new()
        .with("app", query.app.clone())
        .with("from", query.from.clone())
        .with("to", query.to.clone())
        .with("days", days.len())
        .with("scanned", scanned)
        .with("matched", matched)
        .with("rows", Value::Array(rows))
        .with("truncated", truncated)
        .with("servers", Value::Array(servers))
        .with("skippedDays", Value::Array(skipped_days))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    const NOW: i64 = 1_759_320_000_000;

    fn parse_text(text: &str) -> Result<Query, Error> {
        parse_query(&parse(text).unwrap(), NOW)
    }

    #[test]
    fn queries_are_validated() {
        let query = parse_text(r#"{"app":"myapp"}"#).unwrap();
        assert_eq!(
            (query.from.as_str(), query.to.as_str()),
            ("2025-10-01", "2025-10-01")
        );
        assert_eq!(query.measures, ["records"]);
        assert_eq!(query.limit, DEFAULT_LIMIT);
        let query = parse_text(r#"{"app":"myapp","from":"2025-09-01"}"#).unwrap();
        assert_eq!(query.to, "2025-09-01");
        let bad = [
            r#"[]"#,
            r#"{"app":"Bad"}"#,
            r#"{"app":"myapp","extra":1}"#,
            r#"{"app":"myapp","from":"2025-13-01"}"#,
            r#"{"app":"myapp","from":"2025-10-02","to":"2025-10-01"}"#,
            r#"{"app":"myapp","where":[]}"#,
            r#"{"app":"myapp","where":{"at":"1"}}"#,
            r#"{"app":"myapp","where":{"page":[]}}"#,
            r#"{"app":"myapp","where":{"page":1}}"#,
            r#"{"app":"myapp","where":{"constructor":"x"}}"#,
            r#"{"app":"myapp","groupBy":["day","week"]}"#,
            r#"{"app":"myapp","groupBy":["page","page"]}"#,
            r#"{"app":"myapp","groupBy":"page"}"#,
            r#"{"app":"myapp","groupBy":["a","b","c","d","e","f","g","h","i"]}"#,
            r#"{"app":"myapp","measures":["nope"]}"#,
            r#"{"app":"myapp","measures":[]}"#,
            r#"{"app":"myapp","measures":["records","records"]}"#,
            r#"{"app":"myapp","limit":0}"#,
            r#"{"app":"myapp","limit":1.5}"#,
            r#"{"app":"myapp","limit":100001}"#,
        ];
        for text in bad {
            let error = parse_text(text).unwrap_err();
            assert_eq!(error.status, Some(400), "{text}");
        }
        let query =
            parse_text(r#"{"app":"myapp","where":{"zone":["",null,"a.b"],"plan":"pro"}}"#).unwrap();
        assert!(query.filters[0].matches(None));
        assert!(query.filters[0].matches(Some("a.b")));
        assert!(!query.filters[1].matches(None));
    }

    #[test]
    fn visits_by_zone_or_name_need_a_scan() {
        let use_summary = |text: &str| can_use_summary(&parse_text(text).unwrap());
        assert!(use_summary(r#"{"app":"myapp","groupBy":["zone"]}"#));
        assert!(!use_summary(
            r#"{"app":"myapp","groupBy":["zone"],"measures":["visits"]}"#
        ));
        assert!(!use_summary(
            r#"{"app":"myapp","where":{"name":"a.b"},"measures":["visits"]}"#
        ));
        assert!(!use_summary(r#"{"app":"myapp","where":{"visit":"v1"}}"#));
    }

    #[test]
    fn the_answers_of_servers_add_up_and_sort_by_the_first_measure() {
        let query = parse_text(
            r#"{"app":"myapp","groupBy":["page"],"measures":["visits","records"],"limit":2}"#,
        )
        .unwrap();
        let answer = |groups: &str| {
            parse(&format!(
                r#"{{"days":["2025-10-01"],"summaryDays":1,"scanned":5,"matched":4,"skippedDays":[],"groups":{groups}}}"#
            ))
            .unwrap()
        };
        let answers = [
            ServerAnswer {
                server: "a".to_string(),
                answer: answer(
                    r#"[{"by":["/"],"records":3,"visits":2},{"by":["/x"],"records":1,"visits":1}]"#,
                ),
            },
            ServerAnswer {
                server: "b".to_string(),
                answer: answer(
                    r#"[{"by":["/x"],"records":2,"visits":2},{"by":[null],"records":9,"visits":0}]"#,
                ),
            },
        ];
        let result = Value::Object(finalize_query(&query, &answers));
        assert_eq!(
            crate::json::stringify(result.get("rows").unwrap()),
            r#"[{"page":"/x","visits":3,"records":3},{"page":"/","visits":2,"records":3}]"#
        );
        assert_eq!(result.get("truncated"), Some(&Value::Bool(true)));
        assert_eq!(result.get("days").and_then(Value::as_f64), Some(1.0));
        assert_eq!(result.get("scanned").and_then(Value::as_f64), Some(10.0));
        let empty = parse_text(r#"{"app":"myapp"}"#).unwrap();
        let none = Value::Object(finalize_query(&empty, &[]));
        assert_eq!(
            crate::json::stringify(none.get("rows").unwrap()),
            r#"[{"records":0}]"#
        );
    }
}
