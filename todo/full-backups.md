# Back up the full records of a day

## Goal

A backup can hold the column files of a sealed day, not only its summary. A restored day then
answers every query, also a query that names `visit` or counts `visits` with `zone` or `name`.

## Design

- `imp-aly backup --full` adds the files of each sealed folder: `meta.json` and the column files.
- A restore writes the full day into its source folder, see `todo/source-folders.md`.
- The restore must check each value of each column with the record check of its field. It must check
  that all columns have the same number of rows as `meta.json`. It must check that the summary
  agrees with the columns.

## Open points

- The size of a full backup. Measure it for 1,000,000 records.
- A way to add the columns of a day that the server holds only as a summary.

## Done when

- A test restores a full backup, and the scan path and the summary path of the restored day give the
  same result as on the first server.
- `docs/` and `adr/summary-backups.md` describe full backups.
