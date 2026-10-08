# Retention follows free disk space, and keeps the summaries longest

## Context

The owner wants to keep as much history as the disk allows. A fixed age wastes space on a large disk
and fills a small one.

## Decision

**Every minute, the storage worker checks the free space of the data disk with `df -Pk`. While the
free space is below the minimum, it first replaces the oldest days with their daily summaries, then
removes the oldest days that still hold records, then the oldest summary-only days, then the oldest
week summaries, and then the oldest month summaries, one app at a time.**

- The minimum is `--min-free`, a percent of the disk or a size. The default is `10%`.
- The worker takes a day with all its sources, see `source-folders-per-server.md`. A day counts as
  summary-only when each of its sources holds only its summary.
- The worker never removes the current UTC day.
- Step 1 takes each old day with records, the oldest first, and each source of the day. When the
  source has a sealed summary, the worker writes `sealed-<n>.tmp/` with the summary files and a
  `meta.json` with `summaryOnly: true`, renames it to `sealed-<n>/`, and deletes the older sealed
  folder and the raw folders. `n` is one above the highest generation of the source. Late raw
  records of the source are lost with the columns. Step 1 skips a source with no summary, or a
  source where this fails.
- Step 2 runs only when step 1 freed too little. It removes the days that still hold records, the
  oldest first. These are the days that step 1 skipped, such as yesterday before its seal.
- Step 3 runs only when step 2 freed too little. It removes the summary-only days, the oldest first.
  These days come from step 1 and from a restore, see `summary-backups.md`.
- Step 4 runs only when step 3 freed too little. It removes the week summaries, the oldest first.
  Step 5 then removes the month summaries, the oldest first. So the days of a period go before its
  summary, and a week goes before its month. See `week-and-month-summaries.md`.
- The worker takes a period with all its sources. It renames `weeks/<monday>/` or `months/<month>/`
  to a trash folder and deletes it, as for a day.
- The worker renames a day folder with all its sources to `<day>.trash` and then deletes it. A query
  never sees half a day, and the next check deletes a trash folder that a crash left.
- After each day, the worker checks `df` again, so it removes no more than it must.
- When no old day and no period summary is left, the worker logs a warning. When the disk is full,
  the log write fails and the server answers `503`.
- The status of the server shows the last result, or the error of `df`.

## Consequences

- The history is as long as the disk allows, with no setting to tune. A summary is about 2 MB for
  1,000,000 records, so the history of the summaries is much longer than that of the records. The
  month summaries stay longest, and a query grouped by `month` still answers from them.
- A query of an old day that needs the records, such as a query that names `visit`, skips the day.
- Another program that fills the same disk makes the server remove its own history.
- `df` is a system tool, present on Linux and macOS. It is not a dependency of the binary.
