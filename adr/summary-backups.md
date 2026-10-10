# Backups hold the summaries of a period, and a restored day holds only its summary

## Context

The history of a server lives on one disk, and is lost with the disk. An owner wants a copy of the
history on another disk or machine, and wants it back after a loss. The column files of a day are
large. The daily summary of a day is about 2 MB for 1,000,000 records, and it answers most queries
of the imp report. A week or a month summary is about the size of one to three daily summaries, see
`week-and-month-summaries.md`. The storage worker is the only writer of `apps/`, see
`single-writer-storage-worker.md`. An owner wants a backup with few choices: the server, the period
and the granularity.

## Decision

**`GET /backup?last=<period>&by=<granularity>` streams the daily, week or month summaries of all the
apps and sources of the server in the period, as a tar archive in gzip. `POST /restore` takes such a
file, and the storage worker writes each new summary of a source as a summary-only day, week or
month.**

- `last` is `1d`, `7d`, `30d`, `3m`, `6m`, `1y` or `all`, and `all` is the default. The period ends
  at the last sealed day: the day before the day of `now` minus the seal delay. `3m`, `6m` and `1y`
  start on the day after the same day 3, 6 or 12 months before. `by` is `day`, `week` or `month`,
  and `day` is the default. Another option, such as `app`, `from` or `to`, is an error. The CLI
  sends them as `--last` and `--by`.
- Only the CLI makes and restores backups, on the VPS over SSH or on another machine. The console
  has no backup screen. On the VPS, `sudo imp-aly backup` finds the local service with no option,
  see `saved-servers.md`.
- The archive holds `<app>/<source>/days/<day>/`, `<app>/<source>/weeks/<monday>/` or
  `<app>/<source>/months/<month>/`, with `summary-counts.tsv`, `summary-tuples.tsv` and
  `summary-visits.tsv`. A week or a month folder also has `summary-days.tsv`. That file has one line
  per day of the period with its number of records, and the lines must add up to the counts. The
  folder name tells the restore the kind, because a day and a week can have the same id. The source
  is the id of the server that received the records, see `source-folders-per-server.md`. A server
  puts every source that it holds into its backups.
- A small module in `src/tar.js` writes and reads the ustar format. A path longer than 100 bytes is
  split at a `/` into the `prefix` field (155 bytes) and the `name` field, so an app name of 63
  characters fits. The reader joins the two fields of a `ustar` header. `CompressionStream` and
  `DecompressionStream` do the gzip.
- A `day` backup holds each source of a day in the period whose newest generation is a sealed folder
  with a summary. A day with late raw records waits for its next seal.
- A `week` or `month` backup holds only the week or month summaries that are on the disk and current
  at the time of the backup, see `week-and-month-summaries.md`. **The backup never makes a period
  summary.** It only reads, and the storage worker stays the only writer of `apps/`. The server
  makes the period summaries only of its own source. So a source that came from a restore of daily
  summaries has no week or month summaries, and a `week` or `month` backup leaves it out. A `day`
  backup keeps it.
- A week or a month is in the backup only when it is complete and all its days are in the period. A
  period that starts before the first day of `last`, or ends after the last sealed day, is left out.
  So a backup never holds a part of a week or a month, and two backups with periods that do not
  overlap never hold the same week or month.
- The backup runs on the HTTP thread and only reads. It reads each day like a query, and each week
  or month with the check of a query, so a seal or the retention during the backup does not break
  it. A summary that it cannot read is logged and left out.
- `imp-aly backup` writes the stream to `<file>.tmp`, reads the archive again in parallel to check
  it, and renames the file at the end.
- The HTTP thread saves the upload of a restore to `restore/` in the data folder, at most 4 GiB, and
  sends the path to the storage worker. The worker runs the restore between its other steps. When
  the upload sends no byte for 30 seconds, the server stops it, removes the file and answers `408`.
  So a stalled upload does not keep a request and a file for ever.
- The worker reads the whole file once to check it. Each summary must have the right headers, cells,
  counts and tuple numbers, and no control character. Each cell of a type, a page, a zone, a name, a
  country or a segment must pass the record check of its field. A page must be a route pattern, as
  in `app-analytics.json`: it starts with `/`, has at most 512 characters and no control character.
  When a check fails, it restores nothing.
- It then skips each day of a source that it stores already, and each day that is not due for
  sealing. It skips a week or a month of a source that it stores already, and a period that is not
  complete. It writes each other period into `apps/<app>/weeks/<monday>/<source>/` or
  `apps/<app>/months/<month>/<source>/` as `sealed-1/`, with `wal: 0` for each day, see
  `week-and-month-summaries.md`. A query reads such a period with no days when it groups by its
  time, and lists its days in `skippedDays` otherwise. A day of another source is new, so the
  backups of several servers restore into one server. It writes each other day into
  `apps/<app>/<day>/<source>/` as `sealed-1/` with the summary files and a `meta.json` with
  `summaryOnly: true`, `columns: []` and `rows` as the sum of the counts. It writes `sealed-1.tmp/`
  and renames it, like a seal.
- A part of a summary-only day throws "only the daily summary of the day is stored" when a scan
  reads a column. A query skips that source of the day and lists it in `skippedDays`, see
  `json-query-api-in-a-worker.md`.
- The storage worker drops the records of a log part for a summary-only day, and logs a warning.
- The retention makes summary-only days with the same layout, from the summary of a sealed day. It
  removes summary-only days only when no other old day with records is left, see
  `disk-space-retention.md`.

## Consequences

- An owner keeps years of history as small files, and restores them into any server. A restore of
  the backups of two servers into a third gives the same answers as the two servers.
  `test/summary.test.js` checks this for `day`, `week` and `month` backups, and checks that a second
  restore changes nothing.
- A `month` backup of a year holds 12 summaries per source, not 365. A restored week or month
  answers only a query by its time or with no time.
- A `week` or `month` backup of a server that holds a restored source without period summaries does
  not hold that source. The owner makes a `day` backup to keep it.
- A backup cannot select one app or a day range. The owner restores the whole backup, and a query
  selects the app and the days.
- A restored day answers each query that a summary can answer, with the same result as the full day.
  `test/summary.test.js` checks this.
- A query that names `visit`, or that counts `visits` with `zone` or `name`, cannot read a restored
  day. The answer names each skipped day.
- A backup holds no `visit` id and no `at` time.
- The registry and the key are not in a backup. The owner copies `apps.json` and the key file.
