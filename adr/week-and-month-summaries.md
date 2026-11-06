# Each source keeps a summary of each UTC week and month

## Context

A report of a year grouped by `week` or by `month` reads 365 daily summaries per source. The counts
of a complete week or month never change after its last day is sealed. So the server can add up the
daily summaries of a period once, and a query can read one file set per period.

`visits` is the number of distinct visits of each source and day, added up, see
`daily-summaries.md`. A period summary must keep that rule, or the summary path and the scan path
give different numbers. Each day has one folder per source, see `source-folders-per-server.md`, so a
period summary is per source too.

## Decision

**When a UTC week or month is complete, the storage worker adds the daily summaries of its own
source in that period into one summary. A query that groups by that time, or by no time, reads the
period summary when it is current, and reads the days otherwise.**

- A week is Monday to Sunday, UTC, and its id is the Monday, such as `2026-09-28`. A month id is
  `2026-09`.
- The files are in `apps/<app>/weeks/<monday>/<source>/sealed-<n>/` and
  `apps/<app>/months/<month>/<source>/sealed-<n>/`. The `weeks` and `months` folders are next to the
  day folders of the app. A day folder name is a date, so it never collides with them. The source
  level and the generation level are the same as in a day, so a reader uses the same retry on a
  change.
- A period folder holds `summary-counts.tsv`, `summary-tuples.tsv` and `summary-visits.tsv` in the
  format of a daily summary, and a `meta.json` with `summary: true`, `summaryOnly: true`, the number
  of records, and `days`. `days` maps each day that the summary holds to the `rows` and the `wal` of
  the sealed folder of that day.
- The merge adds the counts of equal lines, and joins the tuples into one list. Each visit line of a
  day keeps its own count. Equal lists of tuples from different days share one line, and their
  counts add up. A visit with records on two days stays two visits. The segments of the period are
  all the segments of its days. A day with no value of a segment gets an empty cell.
- A period is complete 1 hour and 10 minutes after the end of its last day, the same delay as a
  seal. In each seal pass, the worker checks each complete period that it did not check since the
  start, and each period of a day that it sealed in the pass. After a restore, it checks all periods
  again. It makes the summary when a day of its source in the period has no summary in the period,
  or has other `rows` or `wal`. It writes `sealed-<n>.tmp/` and renames it, then deletes the older
  generation. It waits while a day of the period still has raw records.
- The worker makes the period summaries only of its own source. A restore writes the period
  summaries of the other sources. A `week` or `month` backup copies only the period summaries that
  are on the disk and current, see `summary-backups.md`.
- A period summary is current when each day of its source in the period is sealed with a summary,
  has no raw records, and has the `rows` and the `wal` that `days` records. A day that the summary
  holds and that has no folder is allowed: the retention removed it. A late record makes the period
  out of date until the worker seals the day and makes the period again. In that time, the query
  reads the days.
- A query reads a period summary when the query can use a summary, the period is fully inside `from`
  and `to`, and the time of the query fits the period. No time fits each period. `week` fits a week.
  `month` fits a month, and a week with all its days in one month. `day` fits no period. The query
  tries the months first, then the weeks, then the days. It does this for each source on its own,
  and adds the counts of the sources. The time value of the groups is the time of the first day of
  the period.
- When a query cannot read a period summary, because a file is missing or fails the check of
  `daily-summaries.md`, it reads the weeks and the days of the period in its place.
- A query that needs the days of a period where only the period summary holds them skips those days.
  It lists each day with its source in `skippedDays`, with the reason "only the summary of the week
  is stored" or "only the summary of the month is stored". `days` in the answer has the days that a
  period summary holds in the range, and `summaryDays` counts a day when each of its sources came
  from a daily or a period summary.

## Consequences

- A query of a year grouped by `month` reads 12 file sets per source, not 365. The answer is the
  same as from the days, also for `visits`. `tests/summary.rs` checks this by `week`, by `month` and
  with no time, and checks that a server with the period summaries of two servers answers like the
  two servers.
- The size of a period summary is the size of the union of the combinations of its days. Most
  combinations of a stable app occur each day, so a week or a month summary is about the size of one
  to three daily summaries. Measured at 1,000,000 records a day: with the demo app `shop`, a day is
  about 70 KB and a week or a month about 80 KB; with 300 pages, 40 countries and 3 segments, a day
  is about 260 KB and a week or a month about 380 KB. For the 2 MB daily summary of
  `daily-summaries.md`, expect about 2 to 6 MB for a week or a month. The upper limit is the sum of
  the daily summaries: 14 MB for a week and 62 MB for a month, when no line repeats.
- The merge of a month reads its daily summaries one after the other, so the memory is about the
  size of the result plus one daily summary.
- The check of a period reads the folder list and `meta.json` of each day of the period. That is
  small next to the read of the summaries that it replaces.
- A late record for an old day makes the queries of its week and month read the days until the next
  seal pass.
- When the worker makes a period again after the retention removed some of its days, the new summary
  holds only the days that are left.
- The retention removes the days before the period summaries, and the week summaries before the
  month summaries, see `disk-space-retention.md`. So the longest history is in the month summaries.
