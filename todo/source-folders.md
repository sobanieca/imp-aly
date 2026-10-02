# Keep the days of each source server in their own folder

## Goal

One server can hold the history of several servers, with no merge of files. An owner can move from
several servers to one server and keep all the history.

## Problem

A day folder `apps/<app>/<day>/` does not tell which server wrote it. Two servers hold the same day
with different visits. A restore of the backups of two servers into one server keeps the first day
and skips the second. A copy of the folders overwrites one day with the other.

## Design

- Each server makes a random id on its first start and keeps it in the data folder. This id is the
  source of the records that the server receives.
- A day has one folder per source: `apps/<app>/<day>/<source>/`. Each source folder has the layout
  of a day folder of today: `sealed-<n>/`, `raw-<n>/` and `commit.json`.
- The storage worker writes the records of the server to its own source. It seals only its own
  source. A restore writes only into a source that the server does not hold yet.
- A backup holds `<app>/<day>/<source>/summary-*.tsv`. A restore writes each day into its source
  folder. It skips a source of a day that the server already holds, so a second restore of the same
  backup changes nothing.
- A query reads each source of a day. It uses the summary of a source when it can, and scans the
  source otherwise. It adds the counts of the sources.
- `visits` is counted per source and per day, then added. A visit with records in two sources counts
  twice, as with two servers. So the summary path and the scan path give the same result.
- `skippedDays` names the source of each skipped part.
- The retention removes or reduces a day with all its sources.

## Risks

- A server that starts from a copy of the data folder of another server has the same id. The docs
  must tell the owner to start a new server with an empty data folder.

## Done when

- A test restores the backups of two servers into a third server. Each query gives the same answer
  as a query of the two servers.
- A test restores the same backup twice and gets the same answer as after one restore.
- A test restores the backup of server B into server A, which stores the same days with columns.
- `adr/summary-backups.md`, `adr/daily-summaries.md`, `adr/sealed-days-sorted-runs.md`,
  `adr/disk-space-retention.md` and `adr/several-servers-merged-by-the-client.md` describe the
  sources. `docs/` explains how to move from several servers to one server.
