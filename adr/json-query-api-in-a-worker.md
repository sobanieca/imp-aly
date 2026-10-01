# Queries are JSON objects, run one at a time in a worker

## Context

The report of imp needs counts of records, counts of distinct visits and percentiles of `readyMs`,
grouped by a few fields and filtered by others. A SQL parser is a large piece of code. A long scan
on the main thread delays the answers of the collect endpoint.

## Decision

**`POST /query` takes a JSON object with `app`, `from`, `to`, `where`, `groupBy`, `measures` and
`limit`. A dedicated worker thread runs one query at a time.**

- `where` maps a dimension to one value or a list. `groupBy` takes dimensions and `day`. The
  measures are `records`, `visits`, and `readyMs` as `avg`, `min`, `max` or `p1` to `p99`, with the
  interpolation of `percentile_cont`.
- The server checks the query on the main thread, so a bad query fails at once with `400`.
- The worker reads only the columns that the query names, builds a selection vector per day, and
  groups with a map.
- Up to 16 queries wait. A query stops after 120 seconds, and the server ends the worker and starts
  a new one. A query that collects more than 10,000,000 distinct visits stops.
- A reader lists the generations of a day before and after it reads the day. When they differ, or a
  file is gone because a seal or the retention removed it, it reads the day again, up to 5 times.

## Consequences

- The query language covers the imp report and nothing more. A new need is a new field of the query.
- A heavy query never delays the collection of records.
- Two owners who query at the same time wait for each other.
