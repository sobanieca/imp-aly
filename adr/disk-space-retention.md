# Retention follows free disk space, not age

## Context

The owner wants to keep as much history as the disk allows. A fixed age wastes space on a large disk
and fills a small one.

## Decision

**Every minute, the storage worker checks the free space of the data disk with `df -Pk`. While the
free space is below the minimum, it removes the oldest day folder, one app at a time.**

- The minimum is `--min-free`, a percent of the disk or a size. The default is `10%`.
- The worker never removes the current UTC day.
- The worker renames a day folder to `<day>.trash` and then deletes it. A query never sees half a
  day, and the next check deletes a trash folder that a crash left.
- After each removal, the worker checks `df` again, so it removes no more than it must.
- When no old day is left, the worker logs a warning. When the disk is full, the log write fails and
  the server answers `503`.
- The status of the server shows the last result, or the error of `df`.

## Consequences

- The history is as long as the disk allows, with no setting to tune.
- Another program that fills the same disk makes the server remove its own history.
- `df` is a system tool, present on Linux and macOS. It is not a dependency of the binary.
