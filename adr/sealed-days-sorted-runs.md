# A finished day is sorted and stored as runs

## Context

The raw files of a day grow by one line per record. Most fields have few values: `type` has five,
`page` has the lines of the app map. In record order these values alternate, so the files are large
and a query parses every line. A finished day never changes, so it can take a better layout once.

## Decision

**24 hours and 10 minutes after the end of a UTC day, the storage worker seals the day: it sorts the
rows and writes each field as a run file.**

- The sort keys are `page`, `type`, `zone`, `name`, `visit` and `at`. The worker computes one order
  from these columns and applies it to every column, so the rows stay aligned.
- To keep memory low, the worker turns each key column into numbers by rank, sorts an index array,
  and then writes one column at a time.
- A run file has one line per run: the count, a tab, and the value. An empty value is null.
- A field with more runs than half its rows gets a plain `.txt` file with one line per row, because
  runs of one row only add the counts.
- `meta.json` holds the number of rows, the fields, the plain fields, and the largest log part id of
  the day.
- The worker writes each file in chunks of about 1 MiB, so it never holds a whole encoded file in
  memory.
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
- A seal holds the whole day in memory: about 500 MB and 10 seconds for 1,000,000 records.
- The server accepts an `at` of up to 24 hours ago, see `utc-day-from-record-time.md`. The delay
  waits for those records, and 10 minutes more for the log, so a sealed day gets no new record.
- A day stays raw for about two days, so queries of the last two days parse plain lines.
