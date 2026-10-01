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
| `visits`                      | the number of different `visit` ids             |
| `readyMs.avg`                 | the mean of `readyMs`, to one decimal           |
| `readyMs.min`, `readyMs.max`  | the smallest and the largest `readyMs`          |
| `readyMs.p1` to `readyMs.p99` | the percentile of `readyMs`, with interpolation |

A `readyMs` measure uses only the `page` records, because only they carry `readyMs`. It is null for
a group with no `page` record.

## The answer

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "days": 30,
  "scanned": 1250000,
  "matched": 98000,
  "rows": [{ "page": "/invoices", "records": 9800, "visits": 8400 }],
  "truncated": false
}
```

The rows are in the order of the first measure, the largest first. `days` is the number of days with
stored data in the range. `scanned` is the number of records in those days, and `matched` is the
number that passed `where`. `truncated` is true when `limit` cut the rows.

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

The server stores each field of a record in its own file, one line per record. A query opens only
the files of the fields that it names. The query above that counts the visits per day and plan reads
the `type`, `plan` and `visit` files. It does not open the `page`, `zone` or `at` files. See
[Storage](storage.md).

The server runs one query at a time, in its own thread, so a long query does not slow down the
collection of records. Up to 16 queries wait. A query stops after 120 seconds with `504`. A query
that counts more than 10,000,000 different visits stops with `400`. Use a shorter range, or fewer
groups.

## The API

```
POST /query
Authorization: Bearer <token>

{ "app": "myapp", ... }
```

The answer is `200` with the answer above, `400` for a query that is not valid, `401` without a
valid token, `503` when 16 queries wait, and `504` when the query takes too long. See
[Security](security.md) for the token.
