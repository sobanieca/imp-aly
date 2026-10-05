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
| `groupBy`  | a list of up to 8 dimensions and times    | one group     |
| `measures` | a list of measures, see below             | `["records"]` |
| `limit`    | the number of rows to return, 1 to 100000 | 1000          |

The **dimensions** are `type`, `visit`, `page`, `zone`, `name`, `country` and the segments of the
app. The **times** are `day`, `week` and `month`, and you can use one of them in `groupBy` only:

| Time    | Value of a group                                 |
| ------- | ------------------------------------------------ |
| `day`   | the UTC day of the record, such as `2026-09-28`  |
| `week`  | the Monday of the UTC week, such as `2026-09-28` |
| `month` | the UTC month, such as `2026-09`                 |

**`where`** maps a dimension to a value, to null, or to a list of them. A record passes when it
matches every entry:

```json
{ "where": { "type": ["page", "used"], "country": "PL", "zone": null } }
```

The **measures** are:

| Measure   | Value of a group                               |
| --------- | ---------------------------------------------- |
| `records` | the number of records                          |
| `visits`  | the visits of each day, added up over the days |

**`visits` counts per day.** For each day, it is the number of different `visit` ids in the group.
For a range, a week or a month, it is the sum of those daily numbers. A visit that lasts past
midnight UTC counts once on each of its days, like a tab that stays open for a week. This keeps the
count exact and fast for any range, because each day is counted once and for good.

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

Pages - views, visits and errors. The `page` rows give the views and the visits:

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "where": { "type": ["page", "error"] },
  "groupBy": ["page", "type"],
  "measures": ["records", "visits"]
}
```

Pages - viewed and used. A `used` record with no zone means that the person clicked, tapped or typed
on the page. A page view sends one at most, so `used` divided by `page` is the share of the page
views where people used the page. This is the query of the Pages report of the console:

```json
{
  "app": "myapp",
  "where": { "type": ["page", "used"], "zone": null },
  "groupBy": ["page", "type"]
}
```

The zones of a page, seen and used. A zone has at most one `seen` and one `used` record per page
view, so `used` divided by `seen` is the share of the page views where people used the zone after
they saw it:

```json
{
  "app": "myapp",
  "where": { "page": "/invoices/:id", "type": ["seen", "used"] },
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

A trend per week, split by a segment:

```json
{
  "app": "myapp",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "where": { "type": "page" },
  "groupBy": ["week", "plan"],
  "measures": ["visits"]
}
```

**Hide a small group in a report.** A group such as "Enterprise plan in Iceland" can be one
customer.

## How a query reads the data

A query reads a day in one of two ways:

- **From the daily summary.** When a day is sealed, the server also writes a small summary of it:
  the number of records per combination of `type`, `page`, `zone`, `name`, `country` and the
  segments, and the pages and types of each visit. A query reads only these files. A day of
  1,000,000 records has a summary of about 2 MB, and a query reads it in about 40 ms.
- **By a scan of the columns.** The server stores each field of a record in its own file, one line
  per record. A scan opens only the files of the fields that the query names. The query above that
  counts the visits per week and plan reads the `type`, `plan` and `visit` files. It does not open
  the `page`, `zone` or `at` files. A scan reads about 1,000,000 records in 2 seconds.

A day from a restore, or an old day after the retention removed its records, has only its summary. A
query that cannot use a summary skips such a day, see [Backup](backup.md#a-summary-only-day).

The server uses the summary of a day when the day is sealed and the query can use it. A query cannot
use a summary when it names `visit` in `where` or `groupBy`, or when it counts `visits` and names
`zone` or `name`. The result is the same both ways. The current day is not sealed yet, so a query
always scans it. The previous day is sealed at 01:10 UTC. See [Storage](storage.md).

An example: an app stores about 1,000,000 records a day. A query of 180 days reads 179 summaries and
scans 1 day, and takes about 6 seconds. The same query as a scan takes about 8 minutes.

The server runs one query at a time, in its own thread, so a long query does not slow down the
collection of records. Up to 16 queries wait. A query stops after 120 seconds with `504`. Use a
shorter range when a scan takes too long.

## Several servers

One server collects the records of a large app. When you need more, run several servers and ask them
together. Each server stores the visits that reach it. `imp-aly query` adds up their answers.

1. Install imp-aly on each VPS, and save each server: `imp-aly add eu-1 https://...`.
2. Register the app on every server with one command:

   ```sh
   imp-aly app add myapp https://myapp.example/ -s eu-1,eu-2,eu-3
   ```

3. Put the URLs of all servers in the `servers` option of `alySink` in your app. The sink picks one
   server for each visit from the visit id. A visit is one load of the page.
4. Ask all servers together:

   ```sh
   imp-aly query report.json -s eu-1,eu-2,eu-3
   ```

**Send all the records of a visit to one server.** When the records of one visit go to two servers,
each server counts the visit, and `visits` counts it twice. `alySink` sends every record of a visit
to one server. It moves a visit to the next server only when its server does not answer or answers
with a 5xx. So only the visits that had the error count twice.

The command asks the servers at the same time, and each server reads only its own records. So a
query of 3 servers takes about one third of the time of the same query on one server.

The numbers are the same as the numbers of one server that holds all the records:

- `records` and `visits` add up exactly.

When a server does not answer, the command prints the rows of the other servers, then an error, and
exits with code 1. The `servers` table shows the server with no numbers. When the app has different
builds or different segments on the servers, the command prints a warning. Register the app again on
every server with the same command.

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
counts of all the servers, then it sorts the rows and applies `limit`:

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
      "visits": 2800
    }
  ],
  "appConfig": "3f1c0a9b2d4e6f70"
}
```

- `by` holds the values of the `groupBy` fields, in the same order.
- `visits` is there when the query asks for `visits`.
- `appConfig` is a short hash of the pages, the zones, the outcome names and the segments of the app
  on the server, or null when the app is not registered.

A server sends at most 100,000 groups. A query that makes more groups fails with `400`. Group by
fewer fields, or use a shorter range.
