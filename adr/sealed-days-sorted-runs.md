# A finished day is sorted and stored as runs

## Context

The raw files of a day grow by one line per record. Most fields have few values: `type` has five,
`page` has the route patterns of the app map. In record order these values alternate, so the files
are large and a query parses every line. A finished day never changes, so it can take a better
layout once.

## Decision

**1 hour and 10 minutes after the end of a UTC day, the storage worker seals the day: it sorts the
rows and writes each field as a run file.**

- The worker seals only the source folder of its own server, `apps/<app>/<day>/<source>/`. The
  folder of another source comes from a restore or a copy, see `source-folders-per-server.md`. The
  generations below are per source folder.

- The sort keys are `page`, `type`, `zone`, `name`, `visit` and `at`. The worker computes one order
  from these columns and applies it to every column, so the rows stay aligned.
- To keep memory low, the worker sorts the day in chunks of 250,000 rows. It turns each key column
  of a chunk into numbers by rank, and sorts an index array. It writes each sorted chunk to
  `sort-<chunk>-<field>.txt` files in the `.tmp` folder, and keeps only the last chunk in memory. A
  day of more than 64 chunks gets larger chunks, so the merge never opens more than 64 chunks.
- The worker then merges the sorted chunks. It reads each chunk file in blocks of 4,096 rows, takes
  the smallest row of all chunks, and appends each field to its run file. Rows with equal keys keep
  the order of arrival.
- A run file has one line per run: the count, a tab, and the value. An empty value is null.
- A field with more runs than half its rows gets a plain `.txt` file with one line per row, because
  runs of one row only add the counts.
- `meta.json` holds the number of rows, the fields, the plain fields, and the largest log part id of
  the day.
- The worker reads each part of the day in blocks of 256 KiB, chunk by chunk, and adds each row to
  the daily summary on the way, see `daily-summaries.md`. It writes each file in pieces of about 1
  MiB.
- The worker first writes every field as a run file. It then rewrites a field with more runs than
  half its rows as a plain file.
- The worker writes `sealed-<n>.tmp/`, syncs it, renames it to `sealed-<n>/`, and then deletes the
  older sealed folder and the raw folders up to `n`. `n` is the highest raw generation that the seal
  took in.
- New records for a sealed day go to `raw-<n+1>/`. A reader reads the highest sealed folder and the
  raw folders above it. The next maintenance seals the day again.
- A leftover `.tmp` folder, an older sealed folder, or a raw folder at or below the sealed
  generation is removed before the next seal.

## Consequences

- The low-cardinality fields of a past day shrink to a few lines, and queries of past days parse
  much less text.
- `visit` and `at` do not shrink. They stay plain lines, see `plain-text-column-files.md`.
- The memory of a seal does not grow with the day. It holds one or two chunks, the blocks of the
  merge and the daily summary. The summary holds each visit of the day once.
- A day of up to 250,000 records needs no chunk files. A larger day is written twice, so it takes
  about 1.5 times as long: about 15 to 20 seconds for 1,000,000 records.
- The server accepts an `at` of up to 1 hour ago, see `utc-day-from-record-time.md`. The delay waits
  for those records, and 10 minutes more for the log, so a sealed day gets no new record.
- A day stays raw until 01:10 UTC of the next day, so a query of the current day parses plain lines.
