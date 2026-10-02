# imp-aly - Queries

A query counts the stored records of one app. It filters the records, puts them into groups and
gives the measures of each group.

```sh
imp-aly query '{"app": "myapp", "from": "2026-09-01", "to": "2026-09-30", "groupBy": ["page"], "measures": ["records", "visits"]}'
imp-aly query report.json
imp-aly query report.json --json
imp-aly query report.json -s eu-1,eu-2,eu-3
```

The command prints a table. `--json` prints the answer as JSON. `-s` with a list of saved servers
asks each server and adds up their answers, see [Several servers](#several-servers).

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

| Measure                       | Value of a group                                            |
| ----------------------------- | ----------------------------------------------------------- |
| `records`                     | the number of records                                       |
| `visits`                      | the visits of each day, added up over the days              |
| `readyMs.avg`                 | the mean of `readyMs`, to one decimal                       |
| `readyMs.min`, `readyMs.max`  | the smallest and the largest `readyMs`                      |
| `readyMs.p1` to `readyMs.p99` | the percentile of `readyMs`, from buckets, see below        |
| `readyMs.under:<ms>`          | the percent of `page` records with a `readyMs` below `<ms>` |

A `readyMs` measure uses only the `page` records, because only they carry `readyMs`. It is null for
a group with no `page` record.

**`readyMs.under:<ms>` is the main measure of speed.** For example, `readyMs.under:2500` is the
percent of the page views that were ready in less than 2.5 seconds. It is exact. `<ms>` is a number
from 1 to 3600000 with at most 2 significant digits, such as `1000`, `2500` or `40000`.

**A percentile comes from buckets.** The server puts each `readyMs` into a bucket: the value with
all digits after the first two set to zero. So 87 stays 87, 423 is in the bucket 420 to 429, and
1234 is in the bucket 1200 to 1299. A percentile is the middle of the bucket that holds the rank, so
the value is at most 5% from the exact value. The rank of `pN` is the smallest count that is at
least N% of the records.

**`visits` counts per day.** For each day, it is the number of different `visit` ids in the group.
For a range, it is the sum of those daily numbers. A visit that lasts past midnight UTC counts once
on each of its days, like a tab that stays open for a week. This keeps the count exact and fast for
any range, because each day is counted once and for good.

## The answer

`imp-aly query --json` prints:

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "days": 30,
  "scanned": 1250000,
  "matched": 98000,
  "rows": [{ "page": "/invoices", "records": 9800, "visits": 8400 }],
  "truncated": false,
  "servers": [
    { "server": "eu", "days": 30, "summaryDays": 28, "scanned": 1250000, "matched": 98000 }
  ],
  "skippedDays": [],
  "failedServers": []
}
```

The rows are in the order of the first measure, the largest first. `days` is the number of days with
stored data in the range. `scanned` is the number of records in the days, and `matched` is the
number that passed `where`. `truncated` is true when `limit` cut the rows.

`servers` has one entry per server that answered. `summaryDays` is the number of days that the
server read from their daily summary, see [How a query reads the data](#how-a-query-reads-the-data).

`skippedDays` lists the days that the query cannot read, each with a `server`, a `day` and a
`reason`. The query counts the other days. A day is skipped when a file of the day is missing or
damaged, or when the day holds only its daily summary and the query needs its records. See
[Backup](backup.md).

`failedServers` lists the servers that did not answer, each with a `server` and a `reason`.

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

The speed of each page: the percent of views that were ready in less than 2.5 seconds, and the 75th
percentile:

```json
{
  "app": "myapp",
  "where": { "type": "page" },
  "groupBy": ["page"],
  "measures": ["readyMs.under:2500", "readyMs.p75", "records"]
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
  the records and the `readyMs` buckets per combination of `type`, `page`, `zone`, `name`, `country`
  and the segments, and the pages and types of each visit. A query reads only these files. A day of
  1,000,000 records has a summary of about 2 MB, and a query reads it in about 40 ms.
- **By a scan of the columns.** The server stores each field of a record in its own file, one line
  per record. A scan opens only the files of the fields that the query names. The query above that
  counts the visits per day and plan reads the `type`, `plan` and `visit` files. It does not open
  the `page`, `zone` or `at` files. A scan reads about 1,000,000 records in 2 seconds.

A day from a restore, or an old day after the retention removed its records, has only its summary. A
query that cannot use a summary skips such a day, see [Backup](backup.md#a-summary-only-day).

The server uses the summary of a day when the day is sealed and the query can use it. A query cannot
use a summary when it names `visit` in `where` or `groupBy`, or when it counts `visits` and names
`zone` or `name`. The result is the same both ways. The current day is not sealed yet, so a query
always scans it. The previous day is sealed at 01:10 UTC. See [Storage](storage.md).

An example: an app with 10,000 people a day stores about 1,100,000 records a day. A query of 180
days reads 179 summaries and scans 1 day, and takes about 6 seconds. The same query as a scan takes
about 8 minutes.

The server runs one query at a time, in its own thread, so a long query does not slow down the
collection of records. Up to 16 queries wait. A query stops after 120 seconds with `504`. Use a
shorter range when a scan takes too long.

## Several servers

One server collects the records of a large app. When you need more, run several servers and ask them
together. Each server stores the visits that reach it. `imp-aly query` adds up their answers.

1. Install imp-aly on each VPS, and save each server: `imp-aly add eu-1 https://...`.
2. Register the app on every server with one command:

   ```sh
   imp-aly app add myapp https://myapp.example/app-map.txt -s eu-1,eu-2,eu-3
   ```

3. Let your app send each visit to one server. A visit is one load of the page. The sink picks a
   server at random when the page loads, and sends every record of that load to it.
4. Ask all servers together:

   ```sh
   imp-aly query report.json -s eu-1,eu-2,eu-3
   ```

**Send all the records of a visit to one server.** When the records of one visit go to two servers,
each server counts the visit, and `visits` counts it twice. A sink that changes the server after an
error splits only the visits that had the error.

The command asks the servers at the same time, and each server reads only its own records. So a
query of 3 servers takes about one third of the time of the same query on one server.

The numbers are the same as the numbers of one server that holds all the records:

- `records`, `visits`, `readyMs.min`, `readyMs.max` and `readyMs.avg` add up exactly.
- The servers send the counts of the `readyMs` buckets, and the command adds the counts. So the
  percentiles and `readyMs.under:<ms>` are the same as on one server.

When a server does not answer, the command prints the rows of the other servers, then an error, and
exits with code 1. The `servers` table shows the server with no numbers. When the app has a
different app map or different segments on the servers, the command prints a warning. Register the
app again on every server with the same command.

## The API

```
POST /query
Authorization: Bearer <token>

{ "app": "myapp", ... }
```

The answer is `200` with the counts of the server, `400` for a query that is not valid, `401`
without a valid token, `503` when 16 queries wait, and `504` when the query takes too long. See
[Security](security.md) for the token.

The server sends the counts of each group, and not the finished rows. `imp-aly query` adds the
counts of all the servers, then it calculates the measures, sorts the rows and applies `limit`:

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "days": ["2026-09-01", "2026-09-02"],
  "summaryDays": 2,
  "scanned": 81000,
  "matched": 6200,
  "skippedDays": [],
  "groups": [
    {
      "by": ["/invoices"],
      "records": 3100,
      "visits": 2800,
      "ready": {
        "count": 3100,
        "sum": 1302000,
        "min": 80,
        "max": 9400,
        "buckets": [[80, 2], [420, 31]]
      }
    }
  ],
  "appConfig": "3f1c0a9b2d4e6f70"
}
```

- `by` holds the values of the `groupBy` fields, in the same order.
- `visits` is there when the query asks for `visits`.
- `ready` is there when the query asks for a `readyMs` measure. `buckets` is there for a percentile
  and for `readyMs.under:<ms>`. Each bucket is a pair of the lower end and the count.
- `appConfig` is a short hash of the app map and the segments of the app on the server, or null when
  the app is not registered.

A server sends at most 100,000 groups. A query that makes more groups fails with `400`. Group by
fewer fields, or use a shorter range.
