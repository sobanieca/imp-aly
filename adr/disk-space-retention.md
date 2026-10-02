# Retention follows free disk space, and keeps the summaries longest

## Context

The owner wants to keep as much history as the disk allows. A fixed age wastes space on a large disk
and fills a small one.

## Decision

**Every minute, the storage worker checks the free space of the data disk with `df -Pk`. While the
free space is below the minimum, it first replaces the oldest days with their daily summaries, then
removes the oldest days that still hold records, and then the oldest summary-only days, one app at a
time.**

- The minimum is `--min-free`, a percent of the disk or a size. The default is `10%`.
- The worker never removes the current UTC day.
- Step 1 takes each old day with records, the oldest first. When the day has a sealed summary, the
  worker writes `sealed-<n>.tmp/` with the summary files and a `meta.json` with `summaryOnly: true`,
  renames it to `sealed-<n>/`, and deletes the older sealed folder and the raw folders. `n` is one
  above the highest generation of the day. Late raw records of the day are lost with the columns.
  Step 1 skips a day with no summary, or a day where this fails.
- Step 2 runs only when step 1 freed too little. It removes the days that still hold records, the
  oldest first. These are the days that step 1 skipped, such as yesterday before its seal.
- Step 3 runs only when step 2 freed too little. It removes the summary-only days, the oldest first.
  These days come from step 1 and from a restore, see `summary-backups.md`.
- The worker renames a day folder to `<day>.trash` and then deletes it. A query never sees half a
  day, and the next check deletes a trash folder that a crash left.
- After each day, the worker checks `df` again, so it removes no more than it must.
- When no old day is left, the worker logs a warning. When the disk is full, the log write fails and
  the server answers `503`.
- The status of the server shows the last result, or the error of `df`.

## Consequences

- The history is as long as the disk allows, with no setting to tune. A summary is about 2 MB for
  1,000,000 records, so the history of the summaries is much longer than that of the records.
- A query of an old day that needs the records, such as a query that names `visit`, skips the day.
- Another program that fills the same disk makes the server remove its own history.
- `df` is a system tool, present on Linux and macOS. It is not a dependency of the binary.
