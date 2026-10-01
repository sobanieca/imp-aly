# imp-analytics-server - Queries

A query counts the stored records of one app. It filters the records, puts them into groups and
gives the measures of each group.

```sh
imp-analytics-server query '{"app": "myapp", "from": "2026-09-01", "to": "2026-09-30", "groupBy": ["page"], "measures": ["records", "visits"]}'
imp-analytics-server query report.json
imp-analytics-server query report.json --json
```

The command prints a table. `--json` prints the answer of the API.

## The query

| Field      | Value                                     | Default       |
| ---------- | ----------------------------------------- | ------------- |
| `app`      | the name of the app                       | required      |
| `from`     | the first day, `YYYY-MM-DD`, UTC          | `to`          |
| `to`       | the last day, `YYYY-MM-DD`, UTC           | `from`, today |
| `where`    | an object of filters, see below           | no filter     |
| `groupBy`  | a list of up to 8 dimensions, or `day`    | one group     |
| `measures` | a list of measures, see below             | `["records"]` |
| `limit`    | the number of rows to return, 1 to 100000 | 1000          |

The **dimensions** are `type`, `visit`, `page`, `zone`, `name`, `country` and the segments of the
app. `day` is the UTC day of the record, and you can use it in `groupBy` only.

**`where`** maps a dimension to a value, to null, or to a list of them. A record passes when it
matches every entry:

```json
{ "where": { "type": ["page", "interaction"], "country": "PL", "zone": null } }
```

The **measures** are:

| Measure                       | Value of a group                                |
| ----------------------------- | ----------------------------------------------- |
| `records`                     | the number of records                           |
| `visits`                      | the visits of each day, added up over the days  |
| `readyMs.avg`                 | the mean of `readyMs`, to one decimal           |
| `readyMs.min`, `readyMs.max`  | the smallest and the largest `readyMs`          |
| `readyMs.p1` to `readyMs.p99` | the percentile of `readyMs`, with interpolation |

A `readyMs` measure uses only the `page` records, because only they carry `readyMs`. It is null for
a group with no `page` record.

**`visits` counts per day.** For each day, it is the number of different `visit` ids in the group.
For a range, it is the sum of those daily numbers. A visit that lasts past midnight UTC counts once
on each of its days, like a tab that stays open for a week. This keeps the count exact and fast for
any range, because each day is counted once and for good.

## The answer

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "days": 30,
  "summaryDays": 28,
  "scanned": 1250000,
  "matched": 98000,
  "rows": [{ "page": "/invoices", "records": 9800, "visits": 8400 }],
  "truncated": false
}
```

The rows are in the order of the first measure, the largest first. `days` is the number of days with
stored data in the range. `summaryDays` is the number of those days that the query read from their
daily summary, see [How a query reads the data](#how-a-query-reads-the-data). `scanned` is the
number of records in the days, and `matched` is the number that passed `where`. `truncated` is true
when `limit` cut the rows.

## The queries of the imp report

The imp docs describe one report for a period. These queries fill it.

Visits:

```json
{ "app": "myapp", "from": "2026-09-01", "to": "2026-09-30", "measures": ["visits"] }
```

Pages - views, visits, interactions and errors. The `page` rows give the views and the visits:

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "where": { "type": ["page", "interaction", "error"] },
  "groupBy": ["page", "type"],
  "measures": ["records", "visits"]
}
```

The ready time of each page, 75th percentile:

```json
{
  "app": "myapp",
  "where": { "type": "page" },
  "groupBy": ["page"],
  "measures": ["readyMs.p75", "records"]
}
```

The zones of a page, seen and used:

```json
{
  "app": "myapp",
  "where": { "page": "/invoices/:id", "type": ["seen", "interaction"] },
  "groupBy": ["zone", "type"]
}
```

The outcomes of a page:

```json
{
  "app": "myapp",
  "where": { "page": "/invoices/:id", "type": "outcome" },
  "groupBy": ["name"]
}
```

A trend per day, split by a segment:

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "where": { "type": "page" },
  "groupBy": ["day", "plan"],
  "measures": ["visits"]
}
```

**Hide a small group in a report.** A group such as "Enterprise plan in Iceland" can be one
customer.

## How a query reads the data

A query reads a day in one of two ways:

- **From the daily summary.** When a day is sealed, the server also writes a small summary of it:
  the records and the `readyMs` values per combination of `type`, `page`, `zone`, `name`, `country`
  and the segments, and the pages and types of each visit. A query reads only these files. A day of
  1,000,000 records has a summary of about 2 MB, and a query reads it in about 40 ms.
- **By a scan of the columns.** The server stores each field of a record in its own file, one line
  per record. A scan opens only the files of the fields that the query names. The query above that
  counts the visits per day and plan reads the `type`, `plan` and `visit` files. It does not open
  the `page`, `zone` or `at` files. A scan reads about 1,000,000 records in 2 seconds.

The server uses the summary of a day when the day is sealed and the query can use it. A query cannot
use a summary when it names `visit` in `where` or `groupBy`, or when it counts `visits` and names
`zone` or `name`. The result is the same both ways. The current day and the previous day are not
sealed yet, so a query always scans them. See [Storage](storage.md).

An example: an app with 10,000 people a day stores about 1,100,000 records a day. A query of 180
days reads 178 summaries and scans 2 days, and takes about 10 seconds. The same query as a scan
takes about 8 minutes.

The server runs one query at a time, in its own thread, so a long query does not slow down the
collection of records. Up to 16 queries wait. A query stops after 120 seconds with `504`. Use a
shorter range when a scan takes too long.

## The API

```
POST /query
Authorization: Bearer <token>

{ "app": "myapp", ... }
```

The answer is `200` with the answer above, `400` for a query that is not valid, `401` without a
valid token, `503` when 16 queries wait, and `504` when the query takes too long. See
[Security](security.md) for the token.
