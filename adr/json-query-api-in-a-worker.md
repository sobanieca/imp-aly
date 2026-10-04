# Queries are JSON objects, run one at a time in a worker

## Context

The report of imp needs counts of records and counts of visits, grouped by a few fields and filtered
by others. A SQL parser is a large piece of code. A long scan on the main thread delays the answers
of the collect endpoint.

## Decision

**`POST /query` takes a JSON object with `app`, `from`, `to`, `where`, `groupBy`, `measures` and
`limit`. A dedicated worker thread runs one query at a time. The server answers the counts of each
group, and the client adds them up.**

- `where` maps a dimension to one value or a list. `groupBy` takes dimensions and one of `day`,
  `week` and `month`. A week is named by its Monday, and a month is `YYYY-MM`. The measures are
  `records` and `visits`.
- The answer of the server has one entry per group, with `records` and `visits`. The client adds up
  the answers of one or more servers, sorts the rows and applies `limit`. One code path serves one
  server and many servers. See `several-servers-merged-by-the-client.md`.
- A server sends at most 100,000 groups, because the client applies `limit` after the merge.
- The server checks the query on the main thread, so a bad query fails at once with `400`.
- The worker reads only the columns that the query names, builds a selection vector per day, and
  groups with a map.
- Up to 16 queries wait. A query stops after 120 seconds, and the server ends the worker and starts
  a new one.
- A query reads a sealed day from its summary when the query allows it, and scans its columns
  otherwise, see `daily-summaries.md`.
- `visits` is the number of distinct visit ids of each day, added up over the days of the range, and
  over the days of a week or a month. So every count adds up, and a week costs the same as its days.
- A reader lists the generations of a day before and after it reads the day. When they differ, it
  reads the day again, up to 5 times. When a file is missing and the generations did not change, the
  file is lost, and the read fails at once.
- A day that a query cannot read does not fail the query. The query counts the other days, and the
  answer lists the day and the problem in `skippedDays`. Each day goes into its own groups first, so
  a day that fails in the middle adds nothing.

## Consequences

- The query language covers the imp report and nothing more. A new need is a new field of the query.
- A caller of the API that is not `imp-aly query` must add up the counts of the groups.
- A heavy query never delays the collection of records.
- Two owners who query at the same time wait for each other.
