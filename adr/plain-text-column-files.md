# Plain text column files, one folder per app and day

## Context

A query of the imp report touches two or three fields of a record, such as `type`, `page` and
`visit`. A row format reads every field of every record. Parquet and a database read only the fields
that a query needs, but they need a large dependency or a second service, see
`rust-server-with-few-dependencies.md`.

## Decision

**Each field of a record has its own text file, with one line per record. Line N of every file in a
folder is record N.**

- The layout is `apps/<app>/<day>/<source>/raw-<n>/<field>.txt`. A day is a folder, so a query of a
  range opens only the folders of its days, and retention removes a day with one delete. A day has
  one folder per source, see `source-folders-per-server.md`.
- The fields are `type`, `visit`, `at`, `page`, `zone`, `name`, `country` and the segments of the
  app. A field that a record does not have is an empty line, which is null.
- A field that appears for the first time in a folder gets a file with one empty line for each
  earlier record. So every file of a folder always has the same number of lines.
- No value can hold a line break, a tab or another control character. The record checks enforce this
  before a record reaches the log: zones, names, segment values and countries take only ASCII
  letters, digits and a few signs, see `build-file-record-validation.md`.
- A query reads only the files of the fields that it names, in blocks of 65,536 rows, see
  `streaming-scan-on-ids.md`.

## Consequences

- An owner can read and check the data with `cat`, `grep` and `wc -l`.
- Text is slower to parse than a binary format. Sealed days, see `sealed-days-sorted-runs.md`, keep
  the files of the past small.
- The format allows an empty text as a value nowhere. The record checks store an empty text as null.
