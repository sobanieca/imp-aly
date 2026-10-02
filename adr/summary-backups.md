# Backups hold the daily summaries, and a restored day holds only its summary

## Context

The history of a server lives on one disk, and is lost with the disk. An owner wants a copy of the
history on another disk or machine, and wants it back after a loss. The column files of a day are
large. The daily summary of a day is about 2 MB for 1,000,000 records, and it answers most queries
of the imp report. The storage worker is the only writer of `apps/`, see
`single-writer-storage-worker.md`.

## Decision

**`GET /backup` streams the daily summaries of the sealed days as a tar archive in gzip.
`POST /restore` takes such a file, and the storage worker writes each new day as a day that holds
only its summary.**

- The archive holds `<app>/<day>/summary-counts.tsv`, `summary-tuples.tsv` and `summary-visits.tsv`.
  A small module in `src/tar.js` writes and reads the ustar format. `CompressionStream` and
  `DecompressionStream` do the gzip.
- The backup holds each day whose newest generation is a sealed folder with a summary. A day with
  late raw records waits for its next seal. `app`, `from` and `to` limit the backup.
- The backup runs on the HTTP thread and only reads. It reads each day like a query, so a seal or
  the retention during the backup does not break it. A day that it cannot read is logged and left
  out.
- `imp-aly backup` writes the stream to `<file>.tmp`, reads the archive again in parallel to check
  it, and renames the file at the end.
- The HTTP thread saves the upload of a restore to `restore/` in the data folder, at most 4 GiB, and
  sends the path to the storage worker. The worker runs the restore between its other steps.
- The worker reads the whole file once to check it. Each summary must have the right headers, cells,
  counts and tuple numbers, and no control character. Each cell of a type, a zone, a name, a country
  or a segment must pass the record check of its field. When a check fails, it restores nothing.
- It then skips each day that it stores already, and each day that is not due for sealing. It writes
  each other day as `sealed-1/` with the summary files and a `meta.json` with `summaryOnly: true`,
  `columns: []` and `rows` as the sum of the counts. It writes `sealed-1.tmp/` and renames it, like
  a seal.
- A part of a summary-only day throws "only the daily summary of the day is stored" when a scan
  reads a column. A query skips the day and lists it in `skippedDays`, see
  `json-query-api-in-a-worker.md`.
- The storage worker drops the records of a log part for a summary-only day, and logs a warning.
- The retention makes summary-only days with the same layout, from the summary of a sealed day. It
  removes summary-only days only when no other old day with records is left, see
  `disk-space-retention.md`.

## Consequences

- An owner keeps years of history as small files, and restores them into any server.
- A restored day answers each query that a summary can answer, with the same result as the full day.
  `test/summary.test.js` checks this.
- A query that names `visit`, or that counts `visits` with `zone` or `name`, cannot read a restored
  day. The answer names each skipped day.
- A backup holds no `visit` id and no `at` time.
- The registry and the key are not in a backup. The owner copies `apps.json` and the key file.
