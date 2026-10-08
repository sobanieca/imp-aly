# Each server has a source id, and a day has one folder per source

## Context

An owner runs several servers, see `several-servers-merged-by-the-client.md`. Each server holds
other visits of the same days. Later the owner wants one server with the history of all of them. A
day folder that does not tell which server wrote it cannot hold the days of two servers. A restore
of the backups of two servers keeps the first day and skips the second, and a copy of the folders
overwrites one day with the other.

## Decision

**Each server makes a random source id on the first start with a data folder, and keeps it in
`source.json`. A day has one folder per source: `apps/<app>/<day>/<source>/`. Each source folder has
the layout of a day: `sealed-<n>/`, `raw-<n>/` and `commit.json`.**

- The id is 16 lowercase hex digits from `crypto.getRandomValues`. The HTTP thread reads or writes
  `source.json` at the start, before the storage worker starts, and gives the id to the worker.
  `GET /status` shows it under `source`.
- The storage worker writes the records of the server only into its own source. It seals only its
  own source. The folder of another source comes from a restore or from a copy by the owner, and
  gets no records.
- A backup holds `<app>/<source>/days/<day>/`, `<app>/<source>/weeks/<monday>/` or
  `<app>/<source>/months/<month>/` with the summary files. A restore writes each day into the folder
  of its source, and skips a day of a source that the server already holds. So a second restore of
  the same backup changes nothing. See `summary-backups.md`.
- A query reads each source of a day. It uses the summary of a source when it can, and scans the
  source otherwise. It adds the counts of the sources. `visits` is counted per source and per day,
  then added, as for two servers. So the summary path and the scan path give the same result, and a
  server with the sources of two servers answers like the two servers.
- `skippedDays` names the day and the source of each skipped part. The other sources of the day
  still count. `summaryDays` counts the days whose sources the query read all from summaries.
- A week and a month summary is per source too: `apps/<app>/weeks/<monday>/<source>/` and
  `apps/<app>/months/<month>/<source>/`. The server makes them only for its own source. A query
  reads the periods of each source on its own, and adds them like the days. See
  `week-and-month-summaries.md`.
- The retention reduces and removes a day with all its sources, see `disk-space-retention.md`.
- The id is not a secret, and it is not part of the key or the token.

## Consequences

- One server can keep the history of several servers, from their backups or from a copy of their
  source folders. The docs explain the move from several servers to one.
- A server that starts on a copy of the data folder of another server has the same id. Then the days
  of the two servers collide again. The docs tell the owner to start a new server with an empty data
  folder. A move of the folder keeps the id, and that is correct, because the owner deletes the old
  folder.
- A visit with records in two sources counts twice, as with two servers.
- A copied source of another server that is not sealed stays raw, and each query scans it.
